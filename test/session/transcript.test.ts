import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/contracts/types.js";
import {
  Transcript,
  projectMessages,
  projectSummary,
  type SessionEvent,
} from "../../src/session/transcript.js";

const system = (content: string): ChatMessage => ({ role: "system", content });
const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

describe("Transcript", () => {
  it("append 记录事件且不共享调用方对象", () => {
    const source = user("a");
    const transcript = new Transcript({ system: system("sys") });
    const seq = transcript.append(source);

    source.content = "changed";
    expect(seq).toBe(1);
    expect(transcript.messages).toEqual([system("sys"), user("a")]);
    expect(transcript.events).toHaveLength(1);
    expect(transcript.events[0]).toMatchObject({ type: "message", seq: 1, message: user("a") });
    expect(() => {
      (transcript.messages[1] as ChatMessage).content = "mutated";
    }).toThrow();
  });

  it("构造时深克隆并冻结加载的事件消息", () => {
    const source = user("original");
    const event: SessionEvent = { type: "message", seq: 1, timestamp: "t", message: source };
    const transcript = new Transcript({ events: [event] });

    source.content = "mutated";
    expect(transcript.messages).toEqual([user("original")]);
    const loaded = transcript.events[0] as Extract<SessionEvent, { type: "message" }>;
    expect(() => {
      loaded.message.content = "mutated in place";
    }).toThrow();
  });

  it("compact 保留边界之后的事实消息", () => {
    const transcript = new Transcript({ system: system("sys") });
    transcript.append(assistant("old"));
    const keptSeq = transcript.append(assistant("kept"));
    const tailSeq = transcript.append(assistant("tail"));
    transcript.compact("summary", keptSeq);

    expect(transcript.summary).toBe("summary");
    expect(transcript.messages).toEqual([
      system("sys"),
      assistant("kept"),
      assistant("tail"),
    ]);
    expect(transcript.messageSeqAt(0)).toBe(keptSeq);
    expect(transcript.messageSeqAt(1)).toBe(tailSeq);
  });

  it("compact null 边界只保留摘要元数据", () => {
    const transcript = new Transcript({ system: system("sys") });
    transcript.append(assistant("old"));
    transcript.compact("summary", null);
    expect(transcript.messages).toEqual([system("sys")]);
    expect(transcript.summary).toBe("summary");
  });

  it("compact 不丢弃用户消息（null 边界也保留）", () => {
    const transcript = new Transcript({ system: system("sys") });
    transcript.append(user("q1"));
    transcript.append(assistant("a1"));
    transcript.append(user("q2"));
    transcript.compact("summary", null);
    expect(transcript.messages).toEqual([
      system("sys"),
      user("q1"),
      user("q2"),
    ]);
    expect(transcript.summary).toBe("summary");
  });

  it("rollbackTo 持久化回滚事件并恢复状态", () => {
    const persisted: SessionEvent[] = [];
    const transcript = new Transcript({
      system: system("sys"),
      persist: (event) => persisted.push(event),
    });
    transcript.append(user("a"));
    transcript.append(user("b"));
    transcript.append(user("c"));
    transcript.rollbackTo(1);

    expect(transcript.messages).toEqual([system("sys"), user("a")]);
    expect(transcript.events).toHaveLength(4);
    expect(transcript.lastSeq).toBe(4);
    expect(persisted.at(-1)).toMatchObject({ type: "rollback", seq: 4, to: 1 });

    transcript.append(user("new"));
    expect(transcript.messages).toEqual([system("sys"), user("a"), user("new")]);
    expect(transcript.lastSeq).toBe(5);
  });

  it("压缩后 rollback 到压缩前能恢复原始消息", () => {
    const transcript = new Transcript({ system: system("sys") });
    transcript.append(user("a"));
    transcript.append(user("b"));
    transcript.append(user("c"));
    const beforeCompaction = transcript.lastSeq;
    transcript.compact("summary", 2);
    transcript.rollbackTo(beforeCompaction);

    expect(transcript.messages).toEqual([
      system("sys"),
      user("a"),
      user("b"),
      user("c"),
    ]);
  });

  it("cancelMessage 使用语义事件标记取消", () => {
    const transcript = new Transcript({ system: system("sys") });
    const seq = transcript.append(assistant("partial"));
    transcript.cancelMessage(seq);

    expect(transcript.messages).toEqual([
      system("sys"),
      { role: "assistant", content: "partial", cancelled: true },
    ]);
    expect(transcript.events.at(-1)).toMatchObject({ type: "messageCancelled", target: seq });
  });

  it("system 是运行时状态，不进入事件日志", () => {
    const transcript = new Transcript({ system: system("old") });
    transcript.setSystem("new");
    transcript.append(user("a"));

    expect(transcript.systemMessage).toEqual(system("new"));
    expect(transcript.messages).toEqual([system("new"), user("a")]);
    expect(transcript.events.map((event) => event.type)).toEqual(["message"]);
  });

  it("persist 失败时不推进内存状态和 seq", () => {
    let shouldFail = true;
    const transcript = new Transcript({
      system: system("sys"),
      persist: (event) => {
        if (shouldFail) throw new Error("disk full");
        expect(event.seq).toBe(1);
      },
    });

    expect(() => transcript.append(user("a"))).toThrow("disk full");
    expect(transcript.messages).toEqual([system("sys")]);
    expect(transcript.lastSeq).toBe(0);

    shouldFail = false;
    transcript.append(user("a"));
    expect(transcript.messages).toEqual([system("sys"), user("a")]);
    expect(transcript.lastSeq).toBe(1);
  });

  it("lastAssistantTextAfter 不依赖消息数组长度", () => {
    const transcript = new Transcript({ system: system("sys") });
    transcript.append(assistant("old"));
    transcript.compact("summary", 1);
    const boundary = transcript.lastSeq;
    transcript.append(assistant("new"));

    expect(transcript.lastAssistantTextAfter(boundary)).toBe("new");
    expect(transcript.lastAssistantSeqAfter(boundary)).toBe(3);
  });

  it("拒绝 system 事实消息和非法回滚边界", () => {
    const transcript = new Transcript({ system: system("sys") });
    expect(() => transcript.append(system("bad"))).toThrow("cannot accept a system message");
    expect(() => transcript.rollbackTo(99)).toThrow("Invalid rollback boundary");
  });
});

describe("projectMessages", () => {
  it("按 rollback 与 compaction 语义重放", () => {
    const events: SessionEvent[] = [
      { type: "message", seq: 1, timestamp: "a", message: user("a") },
      { type: "message", seq: 2, timestamp: "b", message: user("b") },
      { type: "compaction", seq: 3, timestamp: "c", message: user("summary"), firstKeptSeq: 2 },
      { type: "rollback", seq: 4, timestamp: "d", to: 2 },
      { type: "message", seq: 5, timestamp: "e", message: user("c") },
    ];
    expect(projectMessages(events)).toEqual([user("a"), user("b"), user("c")]);
  });

  it("compaction 携带 firstKeptUserSeq 时裁掉旧 user 原文", () => {
    const events: SessionEvent[] = [
      { type: "message", seq: 1, timestamp: "a", message: user("old") },
      { type: "message", seq: 2, timestamp: "b", message: assistant("a1") },
      { type: "message", seq: 3, timestamp: "c", message: user("recent") },
      { type: "compaction", seq: 4, timestamp: "d", message: user("summary"), firstKeptSeq: null, firstKeptUserSeq: 3 },
    ];
    expect(projectMessages(events)).toEqual([user("recent")]);
    expect(projectSummary(events)).toBe("summary");
  });
});
