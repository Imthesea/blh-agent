/** 与模型交互的一条消息（web 侧最小镜像）。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  cancelled?: boolean;
}

/** agent 高层事件（镜像根 core/events.ts 的 AgentEvent）。 */
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_cancelled"; text: string }
  | { type: "turn_end" };

/** 服务器推给浏览器的所有事件：复用 agent 事件 + 审批 + 错误。 */
export type WebEvent =
  | AgentEvent
  | {
      type: "approval_requested";
      requestId: string;
      tool: string;
      target: string;
      args: Record<string, unknown>;
    }
  | { type: "agent_error"; message: string };

export type ApprovalDecision = "allow" | "deny" | "always_allow";

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
}

/** 会话存储的最小接口（根 SessionStore 满足）。 */
export interface SessionStoreLike {
  readonly path: string;
  append(message: ChatMessage): void;
}

export interface SessionStoreModule {
  sessionsDir(workdir: string): string;
  create(workdir: string): SessionStoreLike;
  open(filePath: string): SessionStoreLike;
  load(filePath: string): ChatMessage[];
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

/** SessionManager 依赖的最小会话运行接口（根 Harness 满足）。 */
export interface WebTurnRunner {
  newSession(): ChatMessage[];
  runTurn(messages: ChatMessage[], text: string, events?: WebEventBus, signal?: AbortSignal): Promise<void>;
  sessionStore?: SessionStoreLike | undefined;
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
export type BuildHarness = (deps: BuildHarnessDeps) => WebTurnRunner & {
  jobs?: { agentLock: TurnLock } | undefined;
};

/** Trace 读取模块的最小接口（根包 src/tracing/module.ts 的 createTraceModule 满足）。 */
export interface TraceModule {
  overview(): unknown;
  turns(opts?: { date?: string; sid?: string; limit?: number }): unknown;
  events(cursor: number, date?: string): unknown;
  files(): unknown;
}
