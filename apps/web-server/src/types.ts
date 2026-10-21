import type {
  AgentEvent,
  ApprovalDecision,
  ChatMessage,
  SessionInfo,
  SessionIdResponse,
  SessionListResponse,
  SessionListItem,
  SessionMessagesResponse,
  WebEvent,
} from "@blh/web-protocol";

export type {
  AgentEvent,
  ApprovalDecision,
  ChatMessage,
  SessionInfo,
  SessionIdResponse,
  SessionListResponse,
  SessionListItem,
  SessionMessagesResponse,
  WebEvent,
} from "@blh/web-protocol";

export interface ApprovalRequest {
  tool: string;
  target: string;
  args: Record<string, unknown>;
}

export type ApprovalAsker = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  tool: string;
  target: string;
  action: PermissionAction;
  /** 精确匹配（whole-string equality），不做 glob。 */
  exact?: boolean;
}

/** 会话事件（结构上对应根包的 SessionEvent；web-server 只透传、不解析业务语义）。 */
export interface SessionEventLike {
  seq: number;
  timestamp: string;
  type?: string;
  message?: ChatMessage;
  summary?: string;
  firstKeptSeq?: number | null;
  firstKeptUserSeq?: number | null;
  to?: number;
  target?: number;
}

/** 会话 header（新格式第一行；旧文件可能没有）。 */
export interface SessionHeaderLike {
  type: "session";
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
}

export interface LoadedSessionLike {
  header: SessionHeaderLike | null;
  events: SessionEventLike[];
}

/** 会话存储的最小接口（根 SessionStore 满足）。 */
export interface SessionStoreLike {
  readonly path: string;
  appendEvent(event: SessionEventLike): void;
}

export interface SessionStoreModule {
  sessionsDir(workdir: string): string;
  create(workdir: string): SessionStoreLike;
  open(filePath: string): SessionStoreLike;
  loadSession(filePath: string): LoadedSessionLike;
  loadMessages(filePath: string): ChatMessage[];
  loadSummary(filePath: string): string | null;
  remove(filePath: string): void;
  latest(workdir: string): string | null;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface WebEventBus {
  subscribe(listener: AgentEventListener): () => void;
  emit(event: AgentEvent): Promise<void>;
}

/** 串行化跑轮次的锁（根 JobsRuntime.agentLock 满足）。 */
export interface TurnLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** 后台任务运行时（根 JobsRuntime 满足）：dream/cron 调度与轮次锁。 */
export interface WebJobs {
  agentLock: TurnLock;
  start(): void;
  stop(): Promise<void>;
  abortBackground(): void;
  setDreamTurn(due: () => Promise<boolean>, turn: (signal: AbortSignal) => Promise<void>): void;
}

/** 投影后的会话视图（结构上对应根包 Transcript）。 */
export interface TranscriptLike {
  readonly messages: readonly ChatMessage[];
  readonly messagesWithIds: readonly ChatMessage[];
  readonly lastSeq: number;
  readonly systemMessage: ChatMessage | null;
  readonly summary: string | null;
}

/** SessionManager 依赖的最小会话运行接口（根 Harness 满足）。 */
export interface WebTurnRunner {
  newTranscript(events?: readonly SessionEventLike[]): TranscriptLike;
  runTurn(transcript: TranscriptLike, text: string, events?: WebEventBus, signal?: AbortSignal): Promise<void>;
  sessionStore?: SessionStoreLike | undefined;
  jobs?: WebJobs | undefined;
  /** 释放长生命周期资源；完整 Harness 会实现。 */
  dispose?(timeoutMs?: number): Promise<void>;
  isDreamDue?(): Promise<boolean>;
  runDreamTurn?(transcript: TranscriptLike, signal?: AbortSignal): Promise<void>;
}

export interface BuildHarnessDeps {
  workdir: string;
  cli?: Record<string, unknown>;
  askUser: ApprovalAsker;
  skipPermissions: boolean;
  userRules: PermissionRule[];
  persistRule: (rule: PermissionRule) => void;
}

/** 由宿主（根 CLI）注入的 harness 工厂，避免 web-server 反向依赖根包。 */
export type BuildHarness = (deps: BuildHarnessDeps) => WebTurnRunner;

/** Trace 读取模块的最小接口（根包 src/tracing/module.ts 的 createTraceModule 满足）。 */
export interface TraceModule {
  overview(): unknown;
  turns(opts?: { date?: string; sid?: string; limit?: number }): unknown;
  events(cursor: number, date?: string): { events: unknown[]; nextCursor: number };
  files(): unknown;
}
