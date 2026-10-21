import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatProvider, ToolDefinition } from "../../src/contracts/types.js";
import { Memory } from "../../src/memory/system.js";
import { MemoryStore } from "../../src/memory/store.js";

class MockProvider implements ChatProvider {
  calls = 0;
  constructor(private readonly scripted: ChatMessage[]) {}

  async chat(_messages: ChatMessage[], _tools: ToolDefinition[], _maxTokens?: number): Promise<ChatMessage> {
    const next = this.scripted[this.calls];
    this.calls += 1;
    if (!next) throw new Error("MockProvider exhausted");
    return next;
  }
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "memory-derive-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("Memory.deriveFromSession", () => {
  it("只提取游标之后的消息，成功后推进游标，重复调用不重提", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    const provider = new MockProvider([
      {
        role: "assistant",
        content: JSON.stringify([
          { name: "Pref", type: "user", scope: "persistent", description: "Likes tabs", body: "Use tabs." },
        ]),
      },
    ]);
    const memory = new Memory(store, provider);
    const messages: ChatMessage[] = [
      { role: "user", content: "I prefer tabs", id: "1" },
      { role: "assistant", content: "noted", id: "2" },
    ];
    expect(await memory.deriveFromSession("s1.jsonl", messages)).toBe(1);
    expect(store.readExtractSeq("s1.jsonl")).toBe(2);
    expect(store.readMemoryFile("pref.md")).not.toBeNull();

    // 再次调用：无新消息，不调模型
    expect(await memory.deriveFromSession("s1.jsonl", messages)).toBe(0);
    expect(provider.calls).toBe(1);
  });

  it("提取失败抛错且游标不推进（下次重做同一批）", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    class Boom implements ChatProvider {
      async chat(): Promise<ChatMessage> {
        throw new Error("api down");
      }
    }
    const memory = new Memory(store, new Boom());
    const messages: ChatMessage[] = [{ role: "user", content: "hi", id: "1" }];
    await expect(memory.deriveFromSession("s1.jsonl", messages)).rejects.toThrow("api down");
    expect(store.readExtractSeq("s1.jsonl")).toBe(0);
  });

  it("跨会话游标隔离", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    const provider = new MockProvider([
      { role: "assistant", content: "[]" },
      { role: "assistant", content: "[]" },
    ]);
    const memory = new Memory(store, provider);
    await memory.deriveFromSession("a.jsonl", [{ role: "user", content: "x", id: "5" }]);
    await memory.deriveFromSession("b.jsonl", [{ role: "user", content: "y", id: "3" }]);
    expect(store.readExtractSeq("a.jsonl")).toBe(5);
    expect(store.readExtractSeq("b.jsonl")).toBe(3);
  });
});
