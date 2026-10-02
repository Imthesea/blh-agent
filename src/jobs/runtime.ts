import type { ChatMessage } from "../core/types.js";
import type { BackgroundManager } from "./background.js";
import type { CronJob, CronScheduler } from "./cron.js";
import { AgentLock } from "../core/agent-lock.js";
import { createLogger } from "@blh/logger";

const log = createLogger("jobs.runtime");

/**
 * dream due 检查降频：processQueue 每 200ms 轮询一次，但 isDue() 是一次
 * 轻量的状态读取（读 dream 状态文件），没必要每 200ms 都做，改成每 60s 才
 * 真正评估一次「dream 是否到期」。既省 IO，又避免高频读写状态文件。
 */
const DREAM_CHECK_MS = 60_000;

/**
 * 任务运行时：把「后台任务、定时任务、autodream 回合、互斥锁」组合在一起，
 * 并管理它们的定时器生命周期（start/stop）与轮询调度。
 *
 * 它本身不实现具体回合逻辑，只负责「什么时候该跑什么、谁先谁后、怎么互斥」：
 *  - cronTurn / dreamTurn 这两个回调由外部（Harness/repl）注入进来；
 *  - 到期的 cron 任务与到期的 dream 都由这里抢 agentLock 后串行执行；
 *  - dream 优先于 cron（先检查 dream，dream 没到期才处理 cron）。
 */
export class JobsRuntime {
  /** 全局互斥锁：用户回合、cron、dream、team 回合共用，保证同一时刻只有一个回合在跑 */
  readonly agentLock = new AgentLock();

  /** 外部注入的「跑一轮 cron 定时任务」回调（由 Harness.runScheduledTurn 提供） */
  private cronTurn: ((signal: AbortSignal) => Promise<void>) | null = null;

  /** 外部注入的「判断 dream 是否到期」回调（由 Harness.isDreamDue 提供） */
  private dreamDue: (() => Promise<boolean>) | null = null;

  /** 外部注入的「跑一轮 dream」回调（由 Harness.runDreamTurn 提供） */
  private dreamTurn: ((signal: AbortSignal) => Promise<void>) | null = null;

  /** 当前后台回合（dream/cron）的 AbortController；用户提交新消息时可据此中断进行中的后台回合 */
  private backgroundAbort: AbortController | null = null;

  /** 上一次真正评估 dream due 的时间戳（配合 DREAM_CHECK_MS 降频） */
  private lastDreamCheck = 0;

  /** cron 调度器定时器：每秒 poll 一次，把到期的 cron 任务入内存队列 */
  private schedulerTimer: NodeJS.Timeout | undefined;

  /** 队列轮询定时器：以指数退避的间隔反复调用 processQueue */
  private queueTimer: NodeJS.Timeout | undefined;

  /** 连续失败的次数，用于指数退避（每失败一次轮询间隔翻倍，上限 30s） */
  private queueFailures = 0;

  /** 是否已启动（防止重复 start / 空 stop） */
  started = false;

  constructor(
    readonly background: BackgroundManager,
    readonly cron: CronScheduler,
  ) {}

  /** 注入「跑一轮 cron 回合」的回调；由 Harness 在启动时调用。 */
  setCronTurn(callback: (signal: AbortSignal) => Promise<void>): void {
    this.cronTurn = callback;
  }

  /** 注入「判断到期 + 跑 dream 回合」的两个回调；由 Harness 在启动时调用。 */
  setDreamTurn(due: () => Promise<boolean>, turn: (signal: AbortSignal) => Promise<void>): void {
    this.dreamDue = due;
    this.dreamTurn = turn;
  }

  /** 用户优先：中断进行中的后台回合（dream/cron，其内部会回滚并释放锁）。 */
  abortBackground(): void {
    this.backgroundAbort?.abort();
  }

  /** 把已完成的后台任务结果作为 user 消息注入对话；返回注入条数。 */
  injectBackgroundResults(messages: ChatMessage[]): number {
    const notifications = this.background.collect();
    for (const notification of notifications) {
      messages.push({ role: "user", content: notification });
    }
    return notifications.length;
  }

  /** 取出到期的 cron 任务，逐个作为 `[Scheduled] ...` 的 user 消息注入对话；返回取出的任务列表。 */
  consumeAndInjectCron(messages: ChatMessage[]): CronJob[] {
    const jobs = this.cron.consumeQueue();
    for (const job of jobs) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
    }
    return jobs;
  }

  /** 启动一条后台 bash 命令，返回给模型的提示文本（结果会在后续回合被收集）。 */
  startBackground(command: string): string {
    const taskId = this.background.start(command);
    return (
      `[Background task ${taskId} started] ` +
      "The result will be collected on a later turn."
    );
  }

  /** 启动两个定时器：cron 调度器（每秒）+ 队列轮询（指数退避），并 unref 以免阻塞进程退出。 */
  start(): void {
    if (this.started) return;
    this.schedulerTimer = setInterval(() => {
      try {
        this.cron.pollDue(new Date());
      } catch (error) {
        // Python 等价：线程未捕获异常 → 线程死亡；TS 停表 + 记录，避免崩进程
        if (this.schedulerTimer !== undefined) clearInterval(this.schedulerTimer);
        log.warn("cron scheduler stopped", { error: String(error) });
      }
    }, 1000);
    this.schedulerTimer.unref();
    this.started = true;
    this.scheduleQueuePoll();
  }

  /** 停止所有定时器，重置状态。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.schedulerTimer !== undefined) clearInterval(this.schedulerTimer);
    if (this.queueTimer !== undefined) clearTimeout(this.queueTimer);
    this.schedulerTimer = undefined;
    this.queueTimer = undefined;
    this.queueFailures = 0;
  }

  /**
   * 用 setTimeout 自调度下一轮 processQueue，间隔按失败次数指数退避：
   * 成功归零（200ms），失败翻倍（上限 30s）。用 setTimeout 而非 setInterval，
   * 是为了等上一轮 processQueue 真正结束才排下一轮，避免轮询重入。
   */
  private scheduleQueuePoll(): void {
    if (!this.started) return;
    const delay = Math.min(200 * 2 ** this.queueFailures, 30000);
    this.queueTimer = setTimeout(() => {
      this.processQueue()
        .then(() => {
          this.queueFailures = 0;
          this.scheduleQueuePoll();
        })
        .catch((error: unknown) => {
          this.queueFailures += 1;
          log.warn("cron scheduled turn failed", { retry: this.queueFailures, error: String(error) });
          this.scheduleQueuePoll();
        });
    }, delay);
    this.queueTimer.unref();
  }

  /**
   * 单轮轮询的核心：先检查 dream，再处理 cron。
   *
   * dream 通道：due 检查降频到 60s；到期则抢锁执行。抢不到锁说明用户轮/团队轮
   * 正在跑，直接 return 等下一轮——「用户优先」体现在这里：dream 绝不插队。
   * cron 通道同理，dream 没到期才轮到它。
   */
  private async processQueue(): Promise<void> {
    // dream 通道：due 检查降频；到期则抢锁执行（抢不到说明用户轮/团队轮在跑，等下一轮）。
    if (this.dreamTurn !== null && this.dreamDue !== null && Date.now() - this.lastDreamCheck >= DREAM_CHECK_MS) {
      this.lastDreamCheck = Date.now();
      let due = false;
      try {
        due = await this.dreamDue();
      } catch (error) {
        log.warn("dream due check failed", { error: String(error) });
      }
      if (due) {
        if (!this.agentLock.tryAcquire()) return;
        this.backgroundAbort = new AbortController();
        try {
          await this.dreamTurn(this.backgroundAbort.signal);
        } finally {
          this.backgroundAbort = null;
          this.agentLock.release();
        }
        return;
      }
    }
    if (!this.cron.hasQueue() || !this.agentLock.tryAcquire()) return;
    this.backgroundAbort = new AbortController();
    try {
      if (this.cron.hasQueue() && this.cronTurn !== null) {
        await this.cronTurn(this.backgroundAbort.signal);
      }
    } finally {
      this.backgroundAbort = null;
      this.agentLock.release();
    }
  }
}
