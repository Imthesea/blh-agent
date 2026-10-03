import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubagentRunner } from "../../src/agents/subagent.js";
import { HookBus, PRE_TOOL_USE } from "../../src/core/hooks.js";
import { Tracer } from "../../src/tracing/tracer.js";
import type { ChatMessage, ChatProvider, Config, ToolDefinition } from "../../src/core/types.js";
import { MockProvider, makeTextMessage, makeToolCallMessage } from "../integration/helpers.js";

let tmpDir: string;
let config: Config;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "subagent-"));
  config = { apiKey: "k", model: "m", workdir: tmpDir, bashTimeout: 120, maxOutputChars: 30000 };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SubagentRunner", () => {
  it("returns final text", async () => {
    const runner = new SubagentRunner(new MockProvider([makeTextMessage("done")]), config, new HookBus());
    await expect(runner.run("do it")).resolves.toBe("done");
  });

  it("dispatches a tool call then returns", async () => {
    const runner = new SubagentRunner(
      new MockProvider([
        makeToolCallMessage("write_file", { path: "note.txt", content: "hello" }),
        makeTextMessage("wrote"),
      ]),
      config,
      new HookBus(),
    );
    await expect(runner.run("write a note")).resolves.toBe("wrote");
    expect(readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("hello");
  });
  it("passes the parent AbortSignal to tool handlers", async () => {
    const runner = new SubagentRunner(
      new MockProvider([makeToolCallMessage("record", {}), makeTextMessage("done")]),
      config,
      new HookBus(),
    );
    let toolSignal: AbortSignal | undefined;
    runner.tools.register({
      name: "record",
      description: "",
      parameters: { type: "object" },
      handler: async (_args, signal) => {
        toolSignal = signal;
        return "recorded";
      },
    });
    const controller = new AbortController();
    await expect(runner.run("record the signal", controller.signal)).resolves.toBe("done");
    expect(toolSignal).toBe(controller.signal);
  });
  it("returns without calling the model when already aborted", async () => {
    const provider = new MockProvider([makeTextMessage("should not run")]);
    const runner = new SubagentRunner(provider, config, new HookBus());
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run("do it", controller.signal)).resolves.toBe("Subagent cancelled.");
    expect(provider.calls).toBe(0);
  });

  it("blocks a tool via the PreToolUse hook", async () => {
    const hooks = new HookBus();
    hooks.register(PRE_TOOL_USE, async () => "denied: no");
    const runner = new SubagentRunner(
      new MockProvider([
        makeToolCallMessage("write_file", { path: "note.txt", content: "x" }),
        makeTextMessage("ok"),
      ]),
      config,
      hooks,
    );
    await expect(runner.run("write")).resolves.toBe("ok");
    expect(existsSync(path.join(tmpDir, "note.txt"))).toBe(false);
  });

  it("has no task tool", () => {
    const runner = new SubagentRunner(new MockProvider([]), config, new HookBus());
    const names = new Set(runner.tools.list().map((tool) => tool.name));
    expect(names).toEqual(new Set(["bash", "read_file", "write_file", "edit_file", "glob"]));
  });

  it("stops after 30 turns without a final answer", async () => {
    class EndlessProvider implements ChatProvider {
      calls = 0;
      async chat(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatMessage> {
        this.calls += 1;
        return makeToolCallMessage("write_file", { path: "x.txt", content: "y" }, "c");
      }
    }
    const provider = new EndlessProvider();
    const runner = new SubagentRunner(provider, config, new HookBus());
    const result = await runner.run("loop forever");
    expect(result).toContain("30 turns");
    expect(provider.calls).toBe(30);
  });

  it("records spawn/result trace events", async () => {
    const tracer = new Tracer(tmpDir);
    const runner = new SubagentRunner(new MockProvider([makeTextMessage("done")]), config, new HookBus(), tracer);
    await runner.run("do it");
    const dir = path.join(tmpDir, ".blh", "traces");
    const events = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      );
    expect(events[0]).toMatchObject({ type: "subagent", status: "spawn", task: "do it" });
    expect(events[1]).toMatchObject({ type: "subagent", status: "result" });
    expect(typeof events[1]?.["latency_ms"]).toBe("number");
  });
});
