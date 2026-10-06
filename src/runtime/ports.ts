import type { StopDecision } from "../contracts/goals.js";
import type {
  ChatMessage,
  ChatProvider,
  Config,
  ToolDefinition,
} from "../contracts/types.js";
import type { HookBus } from "./hooks.js";
import type { SessionEvent, Transcript } from "../session/transcript.js";

/**
 * 运行时端口（Port）定义。
 *
 * 这是「端口-适配器」（六边形架构）里的端口层：只声明 Harness 和 agentLoop
 * 依赖的抽象接口（即「能做什么」），不关心具体实现（「怎么做」）。
 * 具体实现（Memory、CronScheduler、GoalController、ContextCompactor 等）
 * 在别处实现，通过构造函数注入进来，从而把核心运行时与外部细节解耦。
 */

/** 工具注册表端口：列出可用工具，并按名字分发执行某个工具。 */
export interface ToolRegistryPort {
  /** 列出所有可用工具的定义（名称、参数 schema 等）。 */
  list(): ToolDefinition[];
  /** 按名字执行一个工具，返回结果文本；signal 用于取消。 */
  dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** 压缩端口：提供三种力度/时机不同的上下文压缩能力。 */
export interface CompactionPlan {
  /** 摘要消息本身。 */
  summaryMessage: ChatMessage;
  /** 输入 messages 数组（含 system）中第一条保留消息的下标；null 表示全量摘要。 */
  firstKeptIndex: number | null;
}

export interface PreparedContext {
  /** 本轮传给 provider 的上下文；可能包含不落盘的本地变换。 */
  messages: ChatMessage[];
  /** 只有语义压缩才设置；本地变换不设置。 */
  compaction?: CompactionPlan;
}

export interface CompactionPort {
  /** 调模型前主动压缩：优先本地操作（挪工具结果、砍中间），实在压不下才做整体摘要。 */
  prepare(messages: readonly ChatMessage[], activeRequest: string): Promise<PreparedContext>;
  /** 上下文超长被 API 拒绝后救急：保留最近几条，更早的历史总结成摘要。 */
  reactiveCompact(messages: readonly ChatMessage[], activeRequest: string): Promise<PreparedContext>;
  /** 最狠的主动压缩：整段历史总结成一条摘要消息。 */
  compactHistory(messages: readonly ChatMessage[], activeRequest: string): Promise<PreparedContext>;
}

/** 压缩器端口：在压缩能力之外，额外暴露「工具结果挪磁盘」的目标目录。 */
export interface CompactorPort extends CompactionPort {
  /** 超大工具结果被挪到磁盘时存放的目录。 */
  readonly toolResultsDir: string;
}

/** 待办端口：跟踪待办使用情况，连续多轮没更新就提醒模型。 */
export interface TodoPort {
  /** 记录本轮是否用了待办；连续多轮没用时返回提醒文本，否则返回 null。 */
  noteRound(usedTodo: boolean): string | null;
}

/** 定时任务端口：只暴露任务 id，供上层确认/恢复。 */
export interface ScheduledJobPort {
  id: string;
}

/** 任务端口：统一管理后台命令、定时任务(cron)以及 dream/团队等定时触发的轮次。 */
export interface JobsPort {
  /** 轮次锁：保证同一时刻只有一个 turn 在执行。 */
  readonly agentLock: TurnLock;
  /** 后台命令相关能力。 */
  readonly background: { hasRunning(): boolean };
  /** 定时任务相关能力：确认完成、列出、失败后恢复重排。 */
  readonly cron: {
    acknowledge(jobs: ScheduledJobPort[]): void;
    listJobs(): ScheduledJobPort[];
    restore(jobs: ScheduledJobPort[]): void;
  };
  /** 取出到期的定时任务并注入对话，返回这批任务。 */
  consumeAndInjectCron(transcript: Transcript): ScheduledJobPort[];
  /** 把跑完的后台任务结果注入对话，返回注入条数。 */
  injectBackgroundResults(transcript: Transcript): number;
  /** 启动一个后台命令，返回句柄。 */
  startBackground(command: string): string;
  /** 启动任务调度循环。 */
  start(): void;
  /** 注册定时任务触发的回调。 */
  setCronTurn(callback: (signal: AbortSignal) => Promise<void>): void;
  /** 注册 dream 到期判断与执行的回调。 */
  setDreamTurn(
    due: () => Promise<boolean>,
    turn: (signal: AbortSignal) => Promise<void>,
  ): void;
  /** 中止所有后台命令。 */
  abortBackground(): void;
  /** 停止调度循环并释放资源。 */
  stop(): Promise<void>;
}

/** 轮次锁：用 withLock 串行化并发的 turn，避免多个轮次同时改写对话。 */
export interface TurnLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** 梦境(autodream)端口：定期深度整合记忆的状态机与快照/回滚能力。 */
export interface DreamPort {
  /** 触发 dream 的提示词。 */
  readonly prompt: string;
  /** 是否到期该跑一次 dream。 */
  isDue(now?: number): boolean;
  /** 记录一次尝试（用于失败后按间隔重试）。 */
  markAttempt(): void;
  /** 标记成功。 */
  markSuccess(): void;
  /** 拍快照，失败时用于回滚。 */
  snapshot(): Record<string, string>;
  /** 用快照回滚记忆。 */
  restore(snapshot: Record<string, string>): void;
  /** 应用待删除(trash)的更改。 */
  applyTrash(): void;
  /** 清空 trash 队列。 */
  clearTrash(): void;
  /** 校验 dream 产出是否合法。 */
  validateOutput(): void;
}

/** 记忆端口：读写持久化记忆，并提供 dream 子状态。 */
export interface MemoryPort {
  readonly dream: DreamPort;
  readonly store: { readonly directory: string };
  /** 生成注入系统提示词的「记忆背景」片段。 */
  systemSection(messages: readonly ChatMessage[]): Promise<string>;
  /** 从当前对话提取值得长期保存的记忆。 */
  extract(messages: readonly ChatMessage[]): Promise<boolean | number>;
  /** 合并整理已有记忆（去重、纠错）。 */
  consolidate(): Promise<boolean | number>;
}

/** 活动目标：只暴露目标达成的判定条件文本。 */
export interface ActiveGoalPort {
  readonly condition: string;
}

/** 目标评估端口：一轮结束后判断目标是否已达成。 */
export interface GoalEvaluationPort {
  readonly active: ActiveGoalPort | null;
  /** 开始一次查询（重置本轮查询状态）。 */
  beginQuery(): void;
  /** 一轮结束后评估目标，返回是否停止的决策。 */
  evaluateAfterTurn(messages: readonly ChatMessage[], backgroundRunning?: boolean): Promise<StopDecision>;
}

/** 目标端口：在评估能力之上，额外提供目标的设置、查询、清除。 */
export interface GoalPort extends GoalEvaluationPort {
  clear(reason?: string): string;
  setGoal(condition: string, tokensAtStart?: number): ActiveGoalPort;
  status(currentTokens?: number): string;
}

/** 会话留档端口：把消息追加落盘，供跨会话恢复。 */
export interface SessionStorePort {
  readonly path: string;
  appendEvent(event: SessionEvent): void;
}

/** 团队 agent 端口：接收队友回传的消息并注入对话，管理团队生命周期。 */
export interface TeamAgentsPort {
  /** 取出队友回传结果注入对话，返回注入条数。 */
  consumeAndInjectTeam(transcript: Transcript): number;
  /** 注册团队轮次的回调（可选）。 */
  setTeamTurn?(callback: (signal: AbortSignal) => Promise<void>): void;
  start?(): void;
  stop?(): void;
  cancel?(): void;
  dispose?(): Promise<void>;
}

/** 扩展端口：注入扩展提供的系统提示片段，并管理 MCP 连接。 */
export interface ExtensionsPort {
  /** 扩展追加到系统提示词的片段。 */
  systemPromptSection(): string;
  readonly mcp: { closeAll(): Promise<void> };
}

/** 追踪端口：记录会话 id、每轮开始/结束/取消以及自定义事件。 */
export interface TracerPort {
  setSid(sid: string): void;
  beginTurn(userMessage: string): void;
  endTurn(reason?: string): void;
  cancelTurn(reason: string): void;
  event(type: string, payload: Record<string, unknown>): void;
}

/** agent 主循环运行时所需的全部依赖（Harness 实现此接口，注入给 agentLoop）。 */
export interface AgentLoopRuntime {
  readonly systemPrompt: string;
  readonly config: Config;
  readonly provider: ChatProvider;
  readonly tools: ToolRegistryPort;
  readonly hooks: HookBus;
  readonly compactor?: CompactionPort | undefined;
  readonly todoManager?: TodoPort | undefined;
  readonly jobs?: JobsPort | undefined;
  readonly sessionStore?: SessionStorePort | undefined;
  readonly goal?: GoalEvaluationPort | undefined;
  readonly tracer?: TracerPort | undefined;
}
