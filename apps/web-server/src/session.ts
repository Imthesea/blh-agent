import * as path from "node:path";
import type {
  ApprovalDecision,
  ChatMessage,
  SessionStoreLike,
  SessionStoreModule,
  TurnLock,
  WebTurnRunner,
} from "./types.js";
import type { WebEvent } from "./bridge.js";
import type { ApprovalCoordinator } from "./approval.js";
import { EventBus } from "./events.js";
import { createLogger } from "@blh/logger";

const log = createLogger("web-server.session");

export interface SessionHandle {
  id: string;
  file: string;
  messages: ChatMessage[];
  store: SessionStoreLike;
}

/** 会话管理：当前单会话实现；接口按多会话可扩展（未来换成 Map<id, handle>）。 */
export class SessionManager {
  private current: SessionHandle | undefined;
  private currentAbort: AbortController | null = null;

  constructor(
    private readonly runner: WebTurnRunner,
    private readonly lock: TurnLock,
    private readonly broadcast: (event: WebEvent) => void,
    private readonly approvals: ApprovalCoordinator,
    private readonly sessionStore: SessionStoreModule,
  ) {}

  async create(workdir: string): Promise<SessionHandle> {
    return this.lock.withLock(async () => this.createUnlocked(workdir));
  }

  private createUnlocked(workdir: string): SessionHandle {
    const store = this.sessionStore.create(workdir);
    this.runner.sessionStore = store;
    const handle: SessionHandle = {
      id: path.basename(store.path),
      file: store.path,
      messages: this.runner.newSession(),
      store,
    };
    log.debug("session created", { file: handle.file });
    this.current = handle;
    return handle;
  }

  async resume(workdir: string, file: string): Promise<SessionHandle> {
    return this.lock.withLock(async () => this.resumeUnlocked(workdir, file));
  }

  private resumeUnlocked(workdir: string, file: string): SessionHandle {
    const fullPath = this.sessionFile(workdir, file);
    const store = this.sessionStore.open(fullPath);
    this.runner.sessionStore = store;
    const messages = this.runner.newSession();
    messages.push(...this.sessionStore.load(fullPath));
    const handle: SessionHandle = { id: file, file: fullPath, messages, store };
    log.debug("session resumed", { file: fullPath });
    this.current = handle;
    return handle;
  }

  get(id: string): SessionHandle | undefined {
    return this.current !== undefined && this.current.id === id ? this.current : undefined;
  }

  /** 当前活跃会话（无则 undefined）；dream 通道经此与用户共享同一会话的消息历史。 */
  get currentHandle(): SessionHandle | undefined {
    return this.current;
  }

  list(): SessionHandle[] {
    return this.current !== undefined ? [this.current] : [];
  }

  runTurn(id: string, text: string): Promise<void> {
    const events = new EventBus();
    const off = events.subscribe((event) => this.broadcast(event));
    const controller = new AbortController();
    const run = () => {
      const handle = this.get(id);
      if (handle === undefined) throw new Error(`no such session: ${id}`);
      // 在真正拿到锁、开始跑之前才登记 currentAbort，避免并发排队时被后一轮覆盖，
      // 导致 stop() 中断的是排队中的轮次而非正在运行的轮次。
      this.currentAbort = controller;
      return this.runner.runTurn(handle.messages, text, events, controller.signal);
    };
    log.debug("run turn", { id, textLength: text.length });
    // 用户提交优先：中断进行中的后台回合（dream/cron，其内部回滚后释放锁）。
    this.runner.jobs?.abortBackground();
    return this.lock.withLock(run).finally(() => {
      off();
      if (this.currentAbort === controller) this.currentAbort = null;
    });
  }

  /** 中断当前正在运行的轮次；没有运行中的轮次则返回 false。 */
  stop(): boolean {
    if (this.currentAbort === null) return false;
    this.currentAbort.abort();
    // 审批等待期间不可中断是 UI 层约束；此处兜底拒绝待审批请求，避免有人绕过前端直接调 /api/stop。
    this.approvals.denyAll();
    return true;
  }

  approve(requestId: string, decision: ApprovalDecision): boolean {
    return this.approvals.resolve(requestId, decision);
  }

  /** 删除会话文件；若删除的是当前会话，则跳到剩余最新会话，无剩余时新建空会话（维持「始终有活跃会话」不变量）。 */
  async remove(workdir: string, file: string): Promise<void> {
    await this.lock.withLock(async () => {
      const fullPath = this.sessionFile(workdir, file);
      this.sessionStore.remove(fullPath);
      if (this.current !== undefined && this.current.file === fullPath) {
        this.current = undefined;
        const next = this.sessionStore.latest(workdir);
        if (next !== null) {
          this.resumeUnlocked(workdir, path.basename(next));
        } else {
          this.createUnlocked(workdir);
        }
      }
      log.debug("session removed", { file: fullPath });
    });
  }

  async dispose(id: string): Promise<void> {
    await this.lock.withLock(async () => {
      if (this.current !== undefined && this.current.id === id) this.current = undefined;
    });
  }

  private sessionFile(workdir: string, file: string): string {
    if (path.basename(file) !== file || file === "." || file === "..") {
      throw new Error(`invalid session file: ${file}`);
    }
    return path.join(this.sessionStore.sessionsDir(workdir), file);
  }
}
