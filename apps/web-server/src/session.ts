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

  create(workdir: string): SessionHandle {
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

  resume(workdir: string, file: string): SessionHandle {
    if (path.basename(file) !== file || file === "." || file === "..") {
      throw new Error(`invalid session file: ${file}`);
    }
    const fullPath = path.join(this.sessionStore.sessionsDir(workdir), file);
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

  list(): SessionHandle[] {
    return this.current !== undefined ? [this.current] : [];
  }

  runTurn(id: string, text: string): Promise<void> {
    const handle = this.get(id);
    if (handle === undefined) return Promise.reject(new Error(`no such session: ${id}`));
    const events = new EventBus();
    const off = events.subscribe((event) => this.broadcast(event));
    const controller = new AbortController();
    this.currentAbort = controller;
    const run = () => this.runner.runTurn(handle.messages, text, events, controller.signal);
    log.debug("run turn", { id, textLength: text.length });
    return this.lock.withLock(run).finally(() => {
      off();
      if (this.currentAbort === controller) this.currentAbort = null;
    });
  }

  /** 中断当前正在运行的轮次；没有运行中的轮次则返回 false。 */
  stop(): boolean {
    if (this.currentAbort === null) return false;
    this.currentAbort.abort();
    return true;
  }

  approve(requestId: string, decision: ApprovalDecision): boolean {
    return this.approvals.resolve(requestId, decision);
  }

  /** 删除会话文件；若删除的是当前会话，则跳到剩余最新会话，无剩余时新建空会话（维持「始终有活跃会话」不变量）。 */
  remove(workdir: string, file: string): void {
    if (path.basename(file) !== file || file === "." || file === "..") {
      throw new Error(`invalid session file: ${file}`);
    }
    const fullPath = path.join(this.sessionStore.sessionsDir(workdir), file);
    this.sessionStore.remove(fullPath);
    if (this.current !== undefined && this.current.file === fullPath) {
      this.current = undefined;
      const next = this.sessionStore.latest(workdir);
      if (next !== null) {
        this.resume(workdir, path.basename(next));
      } else {
        this.create(workdir);
      }
    }
    log.debug("session removed", { file: fullPath });
  }

  dispose(id: string): Promise<void> {
    if (this.current !== undefined && this.current.id === id) this.current = undefined;
    return Promise.resolve();
  }
}
