import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness } from "../../src/runtime/harness.js";
import { HookBus } from "../../src/runtime/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ContextCompactor } from "../../src/compaction/compactor.js";
import { SessionStore } from "../../src/session/store.js";
import { MockProvider, makeTextMessage, makeToolCallMessage } from "./helpers.js";
import type { Config } from "../../src/contracts/types.js";

let tempDir: string;
let config: Config;

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "blh-session-"));
  config = {
    apiKey: "k",
    model: "m",
    workdir: tempDir,
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
});

afterEach(async () => {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function makeHarness(script: ConstructorParameters<typeof MockProvider>[0], compactor?: ContextCompactor) {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: async (args) => `echoed:${String(args.text)}`,
  });
  return new Harness(config, new MockProvider(script), tools, new HookBus(), compactor);
}

describe("session 冒烟（真实落盘，仅 mock LLM）", () => {
  it("append 真实落盘：一轮对话产生唯一且无重复的 session 文件", async () => {
    const store = SessionStore.create(tempDir);
    const harness = makeHarness([
      makeToolCallMessage("echo", { text: "hi" }, "c1"),
      makeTextMessage("done"),
    ]);
    harness.sessionStore = store;
    const transcript = harness.newTranscript();
    await harness.runTurn(transcript, "echo hi");

    const files = fs.readdirSync(path.join(tempDir, ".sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const loaded = SessionStore.loadMessages(store.path);
    expect(loaded.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(loaded.some((m) => m.role === "system")).toBe(false);
  });

  it("压缩不产生 .transcripts 快照", async () => {
    const compactor = new ContextCompactor({
      provider: new MockProvider([]),
      toolResultsDir: path.join(tempDir, ".task_outputs", "tool-results"),
    });
    const store = SessionStore.create(tempDir);
    // 每轮 runTurn 追加 user + assistant 两条消息；26 轮后消息数 52 > snipCompact 默认阈值 50，
    // 下一次 runTurn 开头即触发归档，生成 [N messages archived] marker。
    const turns = 26;
    const replies = Array.from({ length: turns + 2 }, () => makeTextMessage("ok")); // +1 触发轮 +1 余量
    const harness = makeHarness(replies, compactor);
    harness.sessionStore = store;
    const transcript = harness.newTranscript();
    for (let i = 0; i < turns; i++) {
      await harness.runTurn(transcript, `msg ${i}`);
    }
    const before = SessionStore.loadMessages(store.path).length;
    await harness.runTurn(transcript, "trigger compaction");

    // snipCompact 是本地上下文变换，不写入事实消息
    expect(transcript.messages.some((m) => compactor.isArchiveMarker(m))).toBe(false);
    // session 文件仍只有一个（无新快照）
    expect(fs.readdirSync(path.join(tempDir, ".sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    // append 只新增本轮 user + assistant
    expect(SessionStore.loadMessages(store.path).length - before).toBe(2);
    // 不产生 .transcripts
    expect(fs.existsSync(path.join(tempDir, ".transcripts"))).toBe(false);
  });

  it("SessionStore 持久化原语冒烟：latest + load 读回历史并续写同一文件", async () => {
    const store = SessionStore.create(tempDir);
    store.appendEvent({ type: "message", seq: 1, timestamp: new Date(0).toISOString(), message: { role: "user", content: "hello" } });
    store.appendEvent({ type: "message", seq: 2, timestamp: new Date(0).toISOString(), message: { role: "assistant", content: "hi" } });

    const latest = SessionStore.latest(tempDir);
    expect(latest).toBe(store.path);
    expect(SessionStore.loadMessages(latest!)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    const reopened = SessionStore.open(latest!);
    reopened.appendEvent({ type: "message", seq: 3, timestamp: new Date(0).toISOString(), message: { role: "user", content: "again" } });
    expect(SessionStore.loadMessages(latest!)).toHaveLength(3);
    expect(fs.readdirSync(path.join(tempDir, ".sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });
});
