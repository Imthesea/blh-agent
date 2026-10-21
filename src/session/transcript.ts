import type { ChatMessage } from "../contracts/types.js";

/** 所有会话事件共有的基础字段。 */
export interface SessionEventBase {
  /** 稳定自增的事件序号，同时是该事件对应消息的身份标识。 */
  seq: number;
  /** 事件发生的 ISO 时间戳。 */
  timestamp: string;
}

/**
 * 会话事件的联合类型。事件日志是 append-only 的事实来源，
 * 内存中的上下文由这些事件重放投影得到。
 */
export type SessionEvent =
  | (SessionEventBase & {
      /** 追加一条事实消息（user / assistant / tool）。 */
      type: "message";
      message: ChatMessage;
    })
  | (SessionEventBase & {
      /** 语义压缩：上下文变为摘要消息 + firstKeptSeq 之后仍保留的消息。 */
      type: "compaction";
      message: ChatMessage;
      firstKeptSeq: number | null;
      /** user 消息保留边界：缺省或 null = 全部保留（旧行为）；否则只保留 seq >= 该值的 user。 */
      firstKeptUserSeq?: number | null;
    })
  | (SessionEventBase & {
      /** 回滚：丢弃 seq > to 的有效事件，rollback 事件本身仍保留在日志中。 */
      type: "rollback";
      to: number;
    })
  | (SessionEventBase & {
      /** 取消：把 target 指向的 assistant 消息投影为 cancelled: true。 */
      type: "messageCancelled";
      target: number;
    });

/** {@link Transcript} 的构造参数。 */
export interface TranscriptOptions {
  /** 初始 system 消息；为 null 或 undefined 表示无 system。 */
  system?: ChatMessage | null;
  /** 用于重放的既有事件日志（如 --continue 恢复）。 */
  events?: readonly SessionEvent[];
  /** 写前日志回调：commit 时先调用它落盘，成功后才更新内存。 */
  persist?: (event: SessionEvent) => void;
}

/** 投影结果中的单条消息。 */
interface ProjectedMessage {
  /** 消息内容。 */
  message: ChatMessage;
  /** 该消息来源的事件 seq；摘要消息等无来源时为 null。 */
  sourceSeq: number | null;
}

/** 深拷贝一条消息，切断与调用方对象的引用共享。 */
function cloneMessage(message: ChatMessage): ChatMessage {
  return structuredClone(message);
}

/** 深度冻结对象（递归冻结数组/对象的每一层），阻止外部就地修改。 */
function freezeMessage<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeMessage);
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeMessage);
  }
  return Object.freeze(value);
}

/** 入口统一处理：先深拷贝再深度冻结，确保事件持有的消息不可被外部篡改。 */
function prepareMessage(message: ChatMessage): ChatMessage {
  return freezeMessage(cloneMessage(message));
}

/** 类型守卫：收窄 {@link SessionEvent} 到 message 事件。 */
function isMessageEvent(event: SessionEvent): event is Extract<SessionEvent, { type: "message" }> {
  return event.type === "message";
}

/** 判断某事件是否为 assistant 角色的 message 事件。 */
function isAssistantMessageEvent(event: SessionEvent): boolean {
  return isMessageEvent(event) && event.message.role === "assistant";
}

/** 压缩时判定一条投影消息是否保留：user 按 firstKeptUserSeq 保留（null = 全部保留）；其余按 firstKeptSeq 阈值保留。 */
function isKeptAfterCompaction(
  item: ProjectedMessage,
  firstKeptSeq: number | null,
  firstKeptUserSeq: number | null,
): boolean {
  if (item.sourceSeq === null) return false;
  if (item.message.role === "user") {
    return firstKeptUserSeq === null || item.sourceSeq >= firstKeptUserSeq;
  }
  return firstKeptSeq !== null && item.sourceSeq >= firstKeptSeq;
}

/**
 * 事件日志的投影核心：把 append-only 事件重放成当前上下文消息。
 *
 * 分两步：
 * 1. 先处理 rollback，过滤掉 seq > to 的无效事件；
 * 2. 再按有效事件顺序投影出消息列表。
 */
function projectEvents(events: readonly SessionEvent[]): ProjectedMessage[] {
  const effective: SessionEvent[] = [];
  for (const event of events) {
    if (event.type === "rollback") {
      const kept = effective.filter((candidate) => candidate.seq <= event.to);
      effective.splice(0, effective.length, ...kept, event);
      continue;
    }
    effective.push(event);
  }

  let projected: ProjectedMessage[] = [];
  for (const event of effective) {
    if (event.type === "message") {
      projected.push({ message: event.message, sourceSeq: event.seq });
    } else if (event.type === "compaction") {
      const firstKeptSeq = event.firstKeptSeq;
      const firstKeptUserSeq = event.firstKeptUserSeq ?? null;
      const kept = projected.filter((item) => isKeptAfterCompaction(item, firstKeptSeq, firstKeptUserSeq));
      projected = [{ message: event.message, sourceSeq: null }, ...kept];
    } else if (event.type === "messageCancelled") {
      projected = projected.map((item) =>
        item.sourceSeq === event.target
          ? { ...item, message: { ...item.message, cancelled: true } }
          : item,
      );
    }
  }
  return projected;
}

/** 从事件日志投影出不含 system 的消息列表。 */
export function projectMessages(events: readonly SessionEvent[]): ChatMessage[] {
  return projectEvents(events).map((item) => item.message);
}

/**
 * 会话状态：append-only 事件日志 + 纯投影。
 *
 * rawEvents 是事实来源；projected 是它的投影结果。所有事实消息都必须
 * 通过 append / compact / rollbackTo / cancelMessage 写入，保证事件日志与
 * 内存视图一致；system 消息单独持有，不进入事件日志。
 */
export class Transcript {
  private readonly rawEvents: SessionEvent[];
  private system: ChatMessage | null;
  // projected 是 rawEvents 的投影结果；projectEvents 是唯一权威实现，
  // append/compact/cancelMessage 的增量更新必须与 projectEvents 保持一致（避免每次全量重放）。
  private projected: ProjectedMessage[];
  private nextSeq = 1;

  /** 初始化：校验 system 角色与事件 seq 严格递增，并重放事件得到投影。 */
  constructor(private readonly options: TranscriptOptions = {}) {
    if (options.system !== undefined && options.system !== null) {
      if (options.system.role !== "system") {
        throw new Error("Transcript system must be a system message");
      }
      this.system = prepareMessage(options.system);
    } else {
      this.system = null;
    }

    this.rawEvents = (options.events ?? []).map((event) =>
      event.type === "message" || event.type === "compaction"
        ? { ...event, message: prepareMessage(event.message) }
        : event,
    );
    let previousSeq = 0;
    for (const event of this.rawEvents) {
      if (!Number.isInteger(event.seq) || event.seq <= previousSeq) {
        throw new Error(`Session event seq must be increasing: ${event.seq}`);
      }
      previousSeq = event.seq;
    }
    this.nextSeq = previousSeq + 1;
    this.projected = projectEvents(this.rawEvents);
  }

  /** 原始事件日志（含 rollback 事件）；投影时才决定哪些事件有效。 */
  get events(): readonly SessionEvent[] {
    return this.rawEvents;
  }

  /** 当前内存中的 system 消息；可能为 null。 */
  get systemMessage(): ChatMessage | null {
    return this.system;
  }

  /** 模型视图：`[system?, ...conversation]`，供模型与现有读逻辑使用。 */
  get messages(): readonly ChatMessage[] {
    const messages = this.system ? [this.system, ...this.projected.map((item) => item.message)] : this.projected.map((item) => item.message);
    return Object.freeze(messages);
  }

  /** 带稳定 id 的对话视图（id 取自事件 seq；摘要用固定 id），供序列化给前端做稳定 React key。 */
  get messagesWithIds(): readonly ChatMessage[] {
    const withIds = this.projected.map((item) => ({
      ...item.message,
      id: item.sourceSeq === null ? "summary" : String(item.sourceSeq),
    }));
    return this.system ? [this.system, ...withIds] : withIds;
  }

  /** 纯对话（不含 system），供压缩器等只关心历史的调用方使用。 */
  get conversation(): readonly ChatMessage[] {
    return Object.freeze(this.projected.map((item) => item.message));
  }

  /** 消息总数（含 system），O(1)；供计数/日志使用，避免为拿长度而物化 messages 数组。 */
  get messageCount(): number {
    return this.projected.length + (this.system !== null ? 1 : 0);
  }

  /** 当前最大事件 seq（作为回滚边界）。 */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** 追加一条非 system 消息，返回其 seq；传入 system 时抛错。 */
  append(message: ChatMessage): number {
    if (message.role === "system") {
      throw new Error("Transcript.append cannot accept a system message");
    }
    const prepared = prepareMessage(message);
    const event: SessionEvent = {
      type: "message",
      seq: this.nextSeq,
      timestamp: new Date().toISOString(),
      message: prepared,
    };
    this.commit(event);
    this.projected.push({ message: prepared, sourceSeq: event.seq });
    return event.seq;
  }

  /** 更新内存中的 system prompt；不产生事件、不落盘。 */
  setSystem(content: string | null): void {
    this.system =
      content === null
        ? null
        : prepareMessage({ role: "system", content });
  }

  /** 追加压缩事件；firstKeptSeq 为 null 表示非 user 全部摘要；firstKeptUserSeq 为 null 表示保留全部 user。 */
  compact(
    summaryMessage: ChatMessage,
    firstKeptSeq: number | null,
    firstKeptUserSeq: number | null = null,
  ): void {
    if (summaryMessage.role === "system") {
      throw new Error("Compaction summary cannot be a system message");
    }
    if (firstKeptSeq !== null) {
      if (!Number.isInteger(firstKeptSeq) || firstKeptSeq <= 0 || firstKeptSeq > this.lastSeq) {
        throw new Error(`Invalid compaction boundary: ${firstKeptSeq}`);
      }
      if (!this.projected.some((item) => item.sourceSeq === firstKeptSeq)) {
        throw new Error(`Compaction boundary is not in the current context: ${firstKeptSeq}`);
      }
    }
    if (firstKeptUserSeq !== null) {
      if (!Number.isInteger(firstKeptUserSeq) || firstKeptUserSeq <= 0 || firstKeptUserSeq > this.lastSeq) {
        throw new Error(`Invalid compaction user boundary: ${firstKeptUserSeq}`);
      }
      if (!this.projected.some((item) => item.sourceSeq === firstKeptUserSeq && item.message.role === "user")) {
        throw new Error(`Compaction user boundary is not a kept user message: ${firstKeptUserSeq}`);
      }
    }

    const prepared = prepareMessage(summaryMessage);
    const event: SessionEvent = {
      type: "compaction",
      seq: this.nextSeq,
      timestamp: new Date().toISOString(),
      message: prepared,
      firstKeptSeq,
      firstKeptUserSeq,
    };
    this.commit(event);
    const kept = this.projected.filter((item) => isKeptAfterCompaction(item, firstKeptSeq, firstKeptUserSeq));
    this.projected = [{ message: prepared, sourceSeq: null }, ...kept];
  }

  /** 持久化 rollback 事件并重放得到内存状态；seq 必须是 0 或已有事件 seq。 */
  rollbackTo(seq: number): void {
    if (seq !== 0 && (!Number.isInteger(seq) || seq <= 0 || seq > this.lastSeq)) {
      throw new Error(`Invalid rollback boundary: ${seq}`);
    }
    if (seq !== 0 && !this.rawEvents.some((event) => event.seq === seq)) {
      throw new Error(`Rollback boundary must be an existing event: ${seq}`);
    }

    const event: SessionEvent = {
      type: "rollback",
      seq: this.nextSeq,
      timestamp: new Date().toISOString(),
      to: seq,
    };
    this.commit(event);
    this.projected = projectEvents(this.rawEvents);
  }

  /** 标记某条 assistant 消息取消；目标不需要仍在当前上下文中。 */
  cancelMessage(seq: number): void {
    if (!Number.isInteger(seq) || seq <= 0 || seq > this.lastSeq) {
      throw new Error(`Invalid cancelled message: ${seq}`);
    }
    const target = this.rawEvents.find((event) => event.seq === seq);
    if (target === undefined || !isAssistantMessageEvent(target)) {
      throw new Error(`Cancelled target must be an assistant message event: ${seq}`);
    }

    const event: SessionEvent = {
      type: "messageCancelled",
      seq: this.nextSeq,
      timestamp: new Date().toISOString(),
      target: seq,
    };
    this.commit(event);
    this.projected = this.projected.map((item) =>
      item.sourceSeq === seq
        ? { ...item, message: { ...item.message, cancelled: true } }
        : item,
    );
  }

  /** 返回对话视图（不含 system）下标对应的消息事件 seq；摘要消息返回 null。 */
  messageSeqAt(index: number): number | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.projected.length) {
      throw new Error(`Message index out of range: ${index}`);
    }
    return this.projected[index]?.sourceSeq ?? null;
  }

  /** 返回某 seq 之后最后一条 assistant 文本；没有则返回空串。 */
  lastAssistantTextAfter(seq: number): string {
    for (let i = this.projected.length - 1; i >= 0; i--) {
      const item = this.projected[i];
      if (
        item?.message.role === "assistant" &&
        item.message.content !== null &&
        item.sourceSeq !== null &&
        item.sourceSeq > seq
      ) {
        return item.message.content;
      }
    }
    return "";
  }

  /** 返回某 seq 之后最后一条 assistant 消息的事件 seq；没有则返回 null。 */
  lastAssistantSeqAfter(seq: number): number | null {
    for (let i = this.projected.length - 1; i >= 0; i--) {
      const item = this.projected[i];
      if (item?.message.role === "assistant" && item.sourceSeq !== null && item.sourceSeq > seq) {
        return item.sourceSeq;
      }
    }
    return null;
  }

  /** 写前日志提交：先调用 persist 落盘，成功后再更新内存事件与 nextSeq。 */
  private commit(event: SessionEvent): void {
    this.options.persist?.(event);
    this.rawEvents.push(event);
    this.nextSeq = event.seq + 1;
  }
}
