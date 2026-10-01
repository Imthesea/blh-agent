import type { ChatMessage } from "../core/types.js";
import type { BackgroundManager } from "./background.js";
import type { CronJob, CronScheduler } from "./cron.js";
import { createLogger } from "@blh/logger";

const log = createLogger("jobs.runtime");

/** dream due 检查降频：processQueue 每 200ms 轮询，isDue 每 60s 才真正评估一次。 */
const DREAM_CHECK_MS = 60_000;

/** 异步互斥锁：tryAcquire 同步抢锁；acquire 排队等待；release 把所有权移交下一个等待者 */
export class AgentLock {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.held = true;
        resolve();
      });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.held = false;
    } else {
      next(); // 所有权直接移交，held 保持 true
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class JobsRuntime {
  readonly agentLock = new AgentLock();
  private cronTurn: (() => Promise<void>) | null = null;
  private dreamDue: (() => Promise<boolean>) | null = null;
  private dreamTurn: ((signal: AbortSignal) => Promise<void>) | null = null;
  private dreamAbort: AbortController | null = null;
  private lastDreamCheck = 0;
  private schedulerTimer: NodeJS.Timeout | undefined;
  private queueTimer: NodeJS.Timeout | undefined;
  private queueFailures = 0;
  started = false;

  constructor(
    readonly background: BackgroundManager,
    readonly cron: CronScheduler,
  ) {}

  setCronTurn(callback: () => Promise<void>): void {
    this.cronTurn = callback;
  }

  setDreamTurn(due: () => Promise<boolean>, turn: (signal: AbortSignal) => Promise<void>): void {
    this.dreamDue = due;
    this.dreamTurn = turn;
  }

  /** 用户优先：中断正在进行的 dream（dream 内部回滚并释放锁）。 */
  abortDream(): void {
    this.dreamAbort?.abort();
  }

  injectBackgroundResults(messages: ChatMessage[]): number {
    const notifications = this.background.collect();
    for (const notification of notifications) {
      messages.push({ role: "user", content: notification });
    }
    return notifications.length;
  }

  consumeAndInjectCron(messages: ChatMessage[]): CronJob[] {
    const jobs = this.cron.consumeQueue();
    for (const job of jobs) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
    }
    return jobs;
  }

  startBackground(command: string): string {
    const taskId = this.background.start(command);
    return (
      `[Background task ${taskId} started] ` +
      "The result will be collected on a later turn."
    );
  }

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

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.schedulerTimer !== undefined) clearInterval(this.schedulerTimer);
    if (this.queueTimer !== undefined) clearTimeout(this.queueTimer);
    this.schedulerTimer = undefined;
    this.queueTimer = undefined;
    this.queueFailures = 0;
  }

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
        this.dreamAbort = new AbortController();
        try {
          await this.dreamTurn(this.dreamAbort.signal);
        } finally {
          this.dreamAbort = null;
          this.agentLock.release();
        }
        return;
      }
    }
    if (!this.cron.hasQueue() || !this.agentLock.tryAcquire()) return;
    try {
      if (this.cron.hasQueue() && this.cronTurn !== null) {
        await this.cronTurn();
      }
    } finally {
      this.agentLock.release();
    }
  }
}
