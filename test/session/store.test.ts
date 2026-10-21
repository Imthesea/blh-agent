import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/transcript.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-store-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function messageEvent(seq: number, content: string): SessionEvent {
  return {
    type: "message",
    seq,
    timestamp: new Date().toISOString(),
    message: { role: "user", content },
  };
}

describe("SessionStore", () => {
  it("create 写入 session header", () => {
    const store = SessionStore.create(tmpDir);
    const lines = readFileSync(store.path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "session",
      version: 1,
      cwd: path.resolve(tmpDir),
    });
  });

  it("appendEvent 与 loadSession 还原事件", () => {
    const store = SessionStore.create(tmpDir);
    store.appendEvent(messageEvent(1, "a"));
    store.appendEvent(messageEvent(2, "b"));

    const loaded = SessionStore.loadSession(store.path);
    expect(loaded.header?.type).toBe("session");
    expect(loaded.events.map((event) => event.type)).toEqual(["message", "message"]);
    expect(SessionStore.loadMessages(store.path)).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
  });

  it("compaction 事件投影为摘要加保留消息", () => {
    const store = SessionStore.create(tmpDir);
    store.appendEvent({
      type: "message",
      seq: 1,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "a" },
    });
    store.appendEvent({
      type: "message",
      seq: 2,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "b" },
    });
    store.appendEvent({
      type: "compaction",
      seq: 3,
      timestamp: new Date().toISOString(),
      summary: "summary",
      firstKeptSeq: 2,
    });
    expect(SessionStore.loadMessages(store.path)).toEqual([
      { role: "assistant", content: "b" },
    ]);
    expect(SessionStore.loadSummary(store.path)).toBe("summary");
  });

  it("rollback 事件跨进程生效", () => {
    const store = SessionStore.create(tmpDir);
    store.appendEvent(messageEvent(1, "keep"));
    store.appendEvent(messageEvent(2, "discard"));
    store.appendEvent({
      type: "rollback",
      seq: 3,
      timestamp: new Date().toISOString(),
      to: 1,
    });
    store.appendEvent(messageEvent(4, "new"));
    expect(SessionStore.loadMessages(store.path)).toEqual([
      { role: "user", content: "keep" },
      { role: "user", content: "new" },
    ]);
  });

  it("messageCancelled 事件可恢复取消状态", () => {
    const store = SessionStore.create(tmpDir);
    store.appendEvent({
      type: "message",
      seq: 1,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "partial" },
    });
    store.appendEvent({
      type: "messageCancelled",
      seq: 2,
      timestamp: new Date().toISOString(),
      target: 1,
    });
    expect(SessionStore.loadMessages(store.path)).toEqual([
      { role: "assistant", content: "partial", cancelled: true },
    ]);
  });


  it("open 记录现有最大 seq 并拒绝乱序追加", () => {
    const store = SessionStore.create(tmpDir);
    store.appendEvent(messageEvent(1, "a"));
    store.appendEvent(messageEvent(2, "b"));

    const reopened = SessionStore.open(store.path);
    reopened.appendEvent(messageEvent(3, "c"));
    expect(() => reopened.appendEvent(messageEvent(3, "bad"))).toThrow(
      "Session event seq must be greater than 3: 3",
    );
  });

  it("loadMessages 对不存在的文件返回空数组", () => {
    expect(SessionStore.loadMessages(path.join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  it("latest 返回 mtime 最新的 .jsonl", () => {
    expect(SessionStore.latest(tmpDir)).toBeNull();
    const older = SessionStore.create(tmpDir);
    const newer = SessionStore.create(tmpDir);
    writeFileSync(newer.path, `${readFileSync(newer.path, "utf8")}\n`, "utf8");
    expect(SessionStore.latest(tmpDir)).toBe(newer.path);
    expect(newer.path).not.toBe(older.path);
  });

  it("renderMarkdown 把会话投影成 markdown", () => {
    const store = SessionStore.create(tmpDir);
    store.appendEvent({
      type: "message", seq: 1, timestamp: new Date().toISOString(),
      message: { role: "user", content: "hi" },
    });
    store.appendEvent({
      type: "message", seq: 2, timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "hello" },
    });
    const md = SessionStore.renderMarkdown(store.path);
    expect(md).toContain("### user");
    expect(md).toContain("hi");
    expect(md).toContain("### assistant");
    expect(md).toContain("hello");
  });

  it("remove 删除指定会话文件，文件不存在时静默", () => {
    const store = SessionStore.create(tmpDir);
    expect(existsSync(store.path)).toBe(true);
    SessionStore.remove(store.path);
    expect(existsSync(store.path)).toBe(false);
    expect(() => SessionStore.remove(store.path)).not.toThrow();
  });
});
