import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubagentRunner } from "../../src/agents/subagent.js";
import { HookBus } from "../../src/runtime/hooks.js";
import { PRE_TOOL_USE } from "../../src/contracts/hooks.js";
import { Tracer } from "../../src/tracing/tracer.js";
import type {
  ChatMessage,
  ChatProvider,
  Config,
  ToolDefinition,
} from "../../src/contracts/types.js";
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

  it("uses response-scoped usage and traces it under the subagent sid", async () => {
    class UsageProvider implements ChatProvider {
      async chat(): Promise<ChatMessage> {
        throw new Error("chat should not be used");
      }

      async chatWithUsage(): Promise<{
        message: ChatMessage;
        usage: { promptTokens: number; completionTokens: number } | null;
      }> {
        return {
          message: makeTextMessage("done"),
          usage: { promptTokens: 11, completionTokens: 7 },
        };
      }

      lastUsage(): { promptTokens: number; completionTokens: number } {
        return { promptTokens: 999, completionTokens: 999 };
      }
    }

    const tracer = new Tracer(tmpDir);
    const runner = new SubagentRunner(
      new UsageProvider(),
      config,
      new HookBus(),
      tracer,
    );

    await expect(runner.run("do it")).resolves.toBe("done");

    const traceDir = path.join(tmpDir, ".blh", "traces");
    const events = readdirSync(traceDir)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) =>
        readFileSync(path.join(traceDir, file), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
    expect(events.map((event) => event["type"])).toEqual([
      "subagent",
      "turn_start",
      "llm",
      "turn_end",
      "subagent",
    ]);
    expect(events.every((event) => event["sid"] === "cli:subagent")).toBe(true);
    const llmEvents = events.filter((event) => event["type"] === "llm");
    expect(llmEvents).toEqual([
      expect.objectContaining({ sid: "cli:subagent", usage: { promptTokens: 11, completionTokens: 7 } }),
    ]);
  });

  it("returns cancellation when the model call is aborted", async () => {
    class AbortableProvider implements ChatProvider {
      async chat(
        _messages: ChatMessage[],
        _tools: ToolDefinition[],
        _maxTokens?: number,
        signal?: AbortSignal,
      ): Promise<ChatMessage> {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("cancelled"), { name: "AbortError" }),
              ),
            { once: true },
          );
        });
      }
    }

    const provider = new AbortableProvider();
    const runner = new SubagentRunner(provider, config, new HookBus());
    const controller = new AbortController();
    const running = runner.run("do it", controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(running).resolves.toBe("Subagent cancelled.");
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
    expect(events[0]).toMatchObject({ type: "subagent", status: "spawn", task: "do it", sid: "cli:subagent" });
    expect(events.at(-1)).toMatchObject({ type: "subagent", status: "result", sid: "cli:subagent" });
    expect(typeof events.at(-1)?.["latency_ms"]).toBe("number");
  });
});
