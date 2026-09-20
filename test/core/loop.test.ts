import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop, lastAssistantText, parseToolArguments } from "../../src/core/loop.js";
import { Harness } from "../../src/core/harness.js";
import type { TeamAgents } from "../../src/core/harness.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { HookBus, PRE_TOOL_USE } from "../../src/core/hooks.js";
import { ContextCompactor } from "../../src/compaction/compactor.js";
import { MockProvider, makeToolCallMessage, makeTextMessage } from "../integration/helpers.js";
import type { ChatMessage, ChatProvider, Config, ProviderStreamEvent, ToolDefinition } from "../../src/core/types.js";
import { EventBus } from "../../src/core/events.js";
import type { AgentEvent } from "../../src/core/events.js";
import { TodoManager } from "../../src/planning/todo.js";
import { MemoryStore } from "../../src/memory/store.js";
import { Memory } from "../../src/memory/system.js";
import { BackgroundManager } from "../../src/jobs/background.js";
import { CronScheduler } from "../../src/jobs/cron.js";
import { JobsRuntime } from "../../src/jobs/runtime.js";
import { GoalController } from "../../src/goals/controller.js";
import { SessionStore } from "../../src/session/store.js";
import type { GoalEvaluator } from "../../src/goals/evaluator.js";
import type { GoalEvaluation } from "../../src/goals/types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeHarness(
  script: ChatMessage[],
  options: {
    hooks?: HookBus;
    tools?: ToolDefinition[];
    compactor?: ContextCompactor;
    provider?: ChatProvider;
    todoManager?: TodoManager;
    memory?: Memory;
    jobs?: JobsRuntime;
    agents?: TeamAgents;
    goal?: GoalController;
  } = {},
) {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object" },
    handler: async (args) => `echoed:${String(args.text)}`,
  });
  for (const tool of options.tools ?? []) tools.register(tool);
  return new Harness(
    config,
    options.provider ?? new MockProvider(script),
    tools,
    options.hooks ?? new HookBus(),
    options.compactor,
    options.todoManager,
    options.memory,
    options.jobs,
    options.agents,
    undefined,
    options.goal,
  );
}

describe("parseToolArguments", () => {
  it("parses valid JSON object", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
  });
  it("returns {} for invalid JSON or non-object", () => {
    expect(parseToolArguments("not json")).toEqual({});
    expect(parseToolArguments('"[1,2]"')).toEqual({});
    expect(parseToolArguments('"42"')).toEqual({});
  });
});

describe("agentLoop", () => {
  it("runs one tool call then stops on text", async () => {
    const harness = makeHarness([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(harness, messages);
    // user + assistant(tool_call) + tool result + assistant(text)
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "echoed:hi",
    });
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("blocked by PreToolUse hook: appends blocked text, skips dispatch and post hook", async () => {
    const hooks = new HookBus();
    hooks.register(PRE_TOOL_USE, async () => "denied by user");
    const harness = makeHarness(
      [makeToolCallMessage("echo", { text: "hi" }), makeTextMessage("ok")],
      { hooks },
    );
    // 包装 dispatch 计数
    let dispatched = 0;
    const originalDispatch = harness.tools.dispatch.bind(harness.tools);
    harness.tools.dispatch = async (name, args) => {
      dispatched += 1;
      return originalDispatch(name, args);
    };
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(harness, messages);
    expect(dispatched).toBe(0);
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "denied by user",
    });
  });
});

function sequentialEvaluator(results: GoalEvaluation[]): GoalEvaluator {
  let index = 0;
  return {
    evaluate: async () => results[index++] ?? results[results.length - 1]!,
  };
}

describe("agentLoop goal stop hook", () => {
  it("block 续行", async () => {
    const goal = new GoalController(
      sequentialEvaluator([
        { ok: false, reason: "not yet", impossible: false },
        { ok: true, reason: "done", impossible: false },
      ]),
    );
    goal.setGoal("finish");
    const provider = new MockProvider([makeTextMessage("try1"), makeTextMessage("done")]);
    const harness = makeHarness([], { provider, goal });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");
    expect(
      messages.some(
        (m) => m.role === "user" && (m.content ?? "").includes("[Goal still active]"),
      ),
    ).toBe(true);
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("achieved 返回", async () => {
    const goal = new GoalController(
      sequentialEvaluator([{ ok: true, reason: "done", impossible: false }]),
    );
    goal.setGoal("finish");
    const harness = makeHarness([makeTextMessage("done")], { goal });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");
    expect(lastAssistantText(messages)).toBe("done");
    expect(goal.active).toBeNull();
    expect(
      messages.some((m) => (m.content ?? "").includes("[Goal still active]")),
    ).toBe(false);
  });
});

describe("lastAssistantText", () => {
  it("finds last non-empty assistant content", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "first" },
      { role: "user", content: "x" },
      { role: "assistant", content: "second" },
    ];
    expect(lastAssistantText(messages)).toBe("second");
  });
  it("returns empty string when none", () => {
    expect(lastAssistantText([{ role: "user", content: "x" }])).toBe("");
  });
});

class FlakyProvider implements ChatProvider {
  calls = 0;
  private readonly script: (ChatMessage | Error)[];

  constructor(script: (ChatMessage | Error)[]) {
    this.script = [...script];
  }

  async chat(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatMessage> {
    this.calls += 1;
    const action = this.script.shift();
    if (!action) throw new Error("FlakyProvider exhausted");
    if (action instanceof Error) throw action;
    return action;
  }
}

class FakePromptTooLong extends Error {
  readonly status = 400;
}

function makeCompactor(tmpDir: string, provider?: ChatProvider): ContextCompactor {
  return new ContextCompactor({
    provider: provider ?? new MockProvider([]),
    toolResultsDir: path.join(tmpDir, ".task_outputs", "tool-results"),
  });
}

describe("agentLoop 压缩集成", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "loop-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runTurn 把 activeRequest 传给 prepare", async () => {
    const compactor = makeCompactor(tmpDir);
    let seenRequest = "";
    compactor.prepare = async (messages, request) => {
      seenRequest = request;
      return messages;
    };
    const harness = makeHarness([makeTextMessage("done")], { compactor });
    const messages = harness.newSession();
    await harness.runTurn(messages, "fix the bug");
    expect(seenRequest).toBe("fix the bug");
  });

  it("反应式压缩后重试一次", async () => {
    const provider = new FlakyProvider([
      new FakePromptTooLong("Error: prompt_too_long"),
      { role: "assistant", content: "summary of old" },
      makeTextMessage("recovered"),
    ]);
    // compactor 与 harness 共享同一 provider：摘要调用消耗同一脚本
    const compactor = makeCompactor(tmpDir, provider);
    const harness = makeHarness([], { compactor, provider });
    const messages = harness.newSession();
    await harness.runTurn(messages, "hi");
    expect(provider.calls).toBe(3);
    expect(lastAssistantText(messages)).toBe("recovered");
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content?.startsWith("[响应式压缩]")).toBe(true);
  });

  it("重试耗尽后原样抛出", async () => {
    const provider = new FlakyProvider([
      new FakePromptTooLong("prompt_too_long"),
      { role: "assistant", content: "summary" },
      new FakePromptTooLong("still prompt_too_long"),
    ]);
    const compactor = makeCompactor(tmpDir, provider);
    const harness = makeHarness([], { compactor, provider });
    await expect(harness.runTurn(harness.newSession(), "hi")).rejects.toBeInstanceOf(
      FakePromptTooLong,
    );
    expect(provider.calls).toBe(3);
  });

  it("非上下文错误不触发压缩直接抛出", async () => {
    const provider = new FlakyProvider([new Error("boom")]);
    const compactor = makeCompactor(tmpDir);
    const harness = makeHarness([], { compactor, provider });
    await expect(harness.runTurn(harness.newSession(), "hi")).rejects.toThrow("boom");
    expect(provider.calls).toBe(1);
  });

  it("prepare 自动压缩后仍保留 system 消息", async () => {
    const provider = new FlakyProvider([
      { role: "assistant", content: "auto summary" }, // summarizeHistory 消耗
      makeTextMessage("done"),
    ]);
    const compactor = makeCompactor(tmpDir, provider);
    compactor.contextCharLimit = 10; // 极小阈值，纯文本经 micro/fit 无法削减，必然走 compactHistory
    const harness = makeHarness([], { compactor, provider });
    const messages = harness.newSession();
    await harness.runTurn(messages, "a".repeat(1000));
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content?.startsWith("[已压缩]")).toBe(true);
  });

  it("compact 工具在批次闭合后压缩", async () => {
    const sideEffects: string[] = [];
    const tools: ToolDefinition[] = [
      {
        name: "write_note",
        description: "",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        handler: async (args) => {
          sideEffects.push(String(args.text));
          return "noted";
        },
      },
    ];
    const batch: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "write_note", arguments: JSON.stringify({ text: "hello" }) },
        },
        { id: "c2", type: "function", function: { name: "compact", arguments: "{}" } },
      ],
    };
    const provider = new MockProvider([
      batch,
      { role: "assistant", content: "conversation summary" },
      makeTextMessage("done"),
    ]);
    const compactor = makeCompactor(tmpDir, provider);
    const harness = makeHarness([], { tools, compactor, provider });
    const messages = harness.newSession();
    await harness.runTurn(messages, "note then compact");
    // 同批 write_note 的副作用在压缩前完成，不丢失
    expect(sideEffects).toEqual(["hello"]);
    expect(messages).toHaveLength(3); // system + [Compacted] 摘要 + 最终答复
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content?.startsWith("[已压缩]")).toBe(true);
    expect(messages[1]?.content).toContain(
      "当前用户请求：\nnote then compact",
    );
    expect(messages[1]?.content).toContain("conversation summary");
    expect(messages[1]?.content).not.toContain("Full transcript:");
    expect(existsSync(path.join(tmpDir, ".transcripts"))).toBe(false);
  });

  it("systemPrompt 包含压缩消息防护指引", () => {
    const harness = makeHarness([]);
    expect(harness.systemPrompt).toContain("对话摘要");
  });

  it("runTurn 把 user/assistant/tool 追加到 sessionStore", async () => {
    const store = SessionStore.create(tmpDir);
    const harness = makeHarness([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    harness.sessionStore = store;
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");
    expect(SessionStore.load(store.path).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("压缩（snipCompact）不向 sessionStore 追加", async () => {
    const store = SessionStore.create(tmpDir);
    const compactor = makeCompactor(tmpDir);
    const harness = makeHarness([makeTextMessage("done")], { compactor });
    harness.sessionStore = store;
    const messages = harness.newSession();
    for (let i = 0; i < 51; i++) messages.push({ role: "user", content: `m${i}` });
    const before = SessionStore.load(store.path).length;
    await harness.runTurn(messages, "trigger");
    const after = SessionStore.load(store.path).length;
    expect(after - before).toBe(2);
  });
});

describe("agentLoop planning 集成", () => {
  it("连续三轮未更新 todo 后注入 reminder", async () => {
    const todoManager = new TodoManager();
    const script: ChatMessage[] = [];
    for (let i = 0; i < 3; i++) {
      script.push(makeToolCallMessage("echo", { text: "x" }, `call_${i + 1}`));
      script.push(makeTextMessage("done"));
    }
    const harness = makeHarness(script, { todoManager });
    const messages = harness.newSession();
    for (let i = 0; i < 3; i++) {
      await harness.runTurn(messages, "go");
    }
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(
      toolResults.some((m) => (m.content ?? "").includes("<reminder>Update your todos.</reminder>")),
    ).toBe(true);
  });

  it("使用 todo_write 时重置计数不提醒", async () => {
    const todoManager = new TodoManager();
    const todoWriteTool: ToolDefinition = {
      name: "todo_write",
      description: "",
      parameters: {
        type: "object",
        properties: { todos: { type: "array", items: { type: "object" } } },
        required: ["todos"],
      },
      handler: async (args) => todoManager.update(args["todos"]),
    };
    const script: ChatMessage[] = [];
    for (let i = 0; i < 2; i++) {
      script.push(
        makeToolCallMessage("todo_write", { todos: [{ content: "x", status: "pending" }] }, `call_${i + 1}`),
      );
      script.push(makeTextMessage("done"));
    }
    const harness = makeHarness(script, { tools: [todoWriteTool], todoManager });
    const messages = harness.newSession();
    for (let i = 0; i < 2; i++) {
      await harness.runTurn(messages, "go");
    }
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults.some((m) => (m.content ?? "").includes("<reminder>"))).toBe(false);
  });
});

describe("runTurn memory 集成", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "loop-memory-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runTurn injects memory system section", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    store.writeMemoryFile("Indent", "user", "Use tabs", "Tabs not spaces.");
    const provider = new MockProvider([
      { role: "assistant", content: "[0]" }, // recall 选择
      makeTextMessage("done"), // 主循环
      { role: "assistant", content: "[]" }, // extract
    ]);
    const memory = new Memory(store, provider);
    const harness = makeHarness([], { memory, provider });
    const messages = harness.newSession();
    await harness.runTurn(messages, "what indent style do I prefer");
    expect(messages[0]?.content).toContain("相关记忆记录：");
    expect(messages[0]?.content).toContain("Tabs not spaces.");
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("runTurn extracts memories", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    const provider = new MockProvider([
      makeTextMessage("done"), // 主循环(空 store 时 recall 不调用 provider)
      {
        role: "assistant",
        content: JSON.stringify([
          { name: "Pref", type: "user", scope: "persistent", description: "Likes tabs", body: "Use tabs." },
        ]),
      }, // extract
    ]);
    const memory = new Memory(store, provider);
    const harness = makeHarness([], { memory, provider });
    const messages = harness.newSession();
    await harness.runTurn(messages, "I prefer tabs");
    expect(store.readMemoryFile("pref.md")).not.toBeNull();
  });

  it("runTurn consolidates after extract", async () => {
    class FakeMemory {
      extracted: ChatMessage[] | null = null;
      consolidated = false;
      async systemSection(_messages: ChatMessage[]): Promise<string> {
        return "";
      }
      async extract(messages: ChatMessage[]): Promise<number> {
        this.extracted = messages;
        return 1;
      }
      async consolidate(): Promise<number> {
        this.consolidated = true;
        return 1;
      }
    }
    const memory = new FakeMemory();
    const harness = makeHarness([makeTextMessage("done")], {
      memory: memory as unknown as Memory,
    });
    await harness.runTurn(harness.newSession(), "hi");
    expect(memory.extracted).not.toBeNull();
    expect(memory.consolidated).toBe(true);
  });
});

describe("agentLoop jobs 集成", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "loop-jobs-"));
  });

  afterEach(async () => {
    // Windows：后台进程可能仍以 tmpDir 为 cwd，立即 rmSync 会 EPERM；轮询重试直到进程退出
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EBUSY") || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });

  function makeJobs(): JobsRuntime {
    return new JobsRuntime(
      new BackgroundManager(tmpDir),
      new CronScheduler(path.join(tmpDir, ".scheduled_tasks.json")),
    );
  }

  it("runTurn 启动后台 bash 并返回占位结果", async () => {
    const jobs = makeJobs();
    const bashTool: ToolDefinition = {
      name: "bash",
      description: "",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          run_in_background: { type: "boolean" },
        },
        required: ["command"],
      },
      handler: async () => "SYNC",
    };
    const harness = makeHarness(
      [
        makeToolCallMessage("bash", { command: "echo hi", run_in_background: true }),
        makeTextMessage("done"),
      ],
      { tools: [bashTool], jobs },
    );
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults[0]?.content).toContain("Background task bg_");
  });

  it("runTurn 注入后台完成结果通知", async () => {
    const jobs = makeJobs();
    const taskId = jobs.background.start("echo hello");
    const deadline = Date.now() + 5000;
    while (jobs.background.tasks[taskId]?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const harness = makeHarness([makeTextMessage("done")], { jobs });
    const messages = harness.newSession();
    await harness.runTurn(messages, "continue");
    const userMessages = messages.filter((m) => m.role === "user");
    expect(
      userMessages.some((m) => (m.content ?? "").includes("<task_notification>")),
    ).toBe(true);
  });

  it("runTurn 对空后台命令返回 error:", async () => {
    const jobs = makeJobs();
    const bashTool: ToolDefinition = {
      name: "bash",
      description: "",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          run_in_background: { type: "boolean" },
        },
        required: ["command"],
      },
      handler: async () => "SYNC",
    };
    const harness = makeHarness(
      [
        makeToolCallMessage("bash", { command: "", run_in_background: true }),
        makeTextMessage("done"),
      ],
      { tools: [bashTool], jobs },
    );
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults[0]?.content).toContain("error: Bash command cannot be empty");
  });
});

describe("runTeamTurn", () => {
  it("injects team events and loops", async () => {
    let consumed = 0;
    const agents: TeamAgents = {
      consumeAndInjectTeam(messages: ChatMessage[]): number {
        consumed += 1;
        if (consumed === 1) {
          messages.push({ role: "user", content: "[Team events]\nbob: done" });
          return 1;
        }
        return 0;
      },
    };
    const harness = makeHarness([makeTextMessage("acknowledged")], { agents });
    const messages = harness.newSession();
    await harness.runTeamTurn(messages);
    expect(consumed).toBe(1);
    expect(lastAssistantText(messages)).toBe("acknowledged");
  });

  it("loop dispatches task tool", async () => {
    const seen: string[] = [];
    const taskTool: ToolDefinition = {
      name: "task",
      description: "",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
      handler: async (args) => {
        seen.push(String(args["prompt"] ?? ""));
        return "sub-result";
      },
    };
    const harness = makeHarness(
      [makeToolCallMessage("task", { prompt: "explore" }), makeTextMessage("done")],
      { tools: [taskTool] },
    );
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults[0]?.content).toBe("sub-result");
    expect(seen).toEqual(["explore"]);
  });
});

describe("runScheduledTurn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "loop-scheduled-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeJobs(): JobsRuntime {
    return new JobsRuntime(
      new BackgroundManager(tmpDir),
      new CronScheduler(path.join(tmpDir, ".scheduled_tasks.json")),
    );
  }

  it("no-ops when jobs is undefined", async () => {
    const harness = makeHarness([makeTextMessage("done")]);
    const messages = harness.newSession();
    await harness.runScheduledTurn(messages);
    expect(messages).toHaveLength(1);
  });

  it("consumes due cron, runs the loop, and acknowledges", async () => {
    const jobs = makeJobs();
    const job = jobs.cron.schedule("* * * * *", "run tests");
    jobs.cron.pollDue(new Date(2026, 8, 14, 10, 30));
    const harness = makeHarness([makeTextMessage("done")], { jobs });
    const messages = harness.newSession();
    await harness.runScheduledTurn(messages);
    expect(
      messages.some(
        (m) => m.role === "user" && (m.content ?? "").includes("[Scheduled] run tests"),
      ),
    ).toBe(true);
    expect(job.pending_delivery).toBe(false);
  });

  it("rolls back injected messages and restores the queue on error", async () => {
    const jobs = makeJobs();
    jobs.cron.schedule("* * * * *", "run tests");
    jobs.cron.pollDue(new Date(2026, 8, 14, 10, 30));
    const provider = new FlakyProvider([new Error("boom")]);
    const harness = makeHarness([], { jobs, provider });
    const messages = harness.newSession();
    await expect(harness.runScheduledTurn(messages)).rejects.toThrow("boom");
    expect(
      messages.some((m) => (m.content ?? "").includes("[Scheduled]")),
    ).toBe(false);
    expect(jobs.cron.hasQueue()).toBe(true);
  });
});

class StreamingProvider implements ChatProvider {
  constructor(private readonly script: ChatMessage[]) {}

  async chat(): Promise<ChatMessage> {
    throw new Error("StreamingProvider.chat unused");
  }

  async *stream(_messages: ChatMessage[], _tools: ToolDefinition[]): AsyncIterable<ProviderStreamEvent> {
    const message = this.script.shift();
    if (!message) throw new Error("StreamingProvider: script exhausted");
    if (message.content) yield { type: "text_delta", text: message.content };
    yield { type: "done", message };
  }
}

class FailingStreamProvider implements ChatProvider {
  constructor(private readonly script: ChatMessage[]) {}

  async chat(): Promise<ChatMessage> {
    const next = this.script.shift();
    if (!next) throw new Error("FailingStreamProvider: script exhausted");
    return next;
  }

  async *stream(): AsyncIterable<ProviderStreamEvent> {
    throw new Error("stream unsupported");
  }
}

describe("agentLoop streaming events", () => {
  it("emits turn/tool/text events in order via EventBus", async () => {
    const provider = new StreamingProvider([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    const harness = makeHarness([], { provider });
    const events: AgentEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      events.push(e);
    });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go", bus);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "assistant_text_delta",
      "turn_end",
    ]);
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "echo",
      arguments: '{"text":"hi"}',
    });
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toEqual({
      type: "tool_result",
      id: "call_1",
      name: "echo",
      output: "echoed:hi",
      isError: false,
    });
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("marks denied results as error", async () => {
    const denyTool: ToolDefinition = {
      name: "deny",
      description: "",
      parameters: { type: "object" },
      handler: async () => "denied: not allowed",
    };
    const provider = new StreamingProvider([
      makeToolCallMessage("deny", {}),
      makeTextMessage("done"),
    ]);
    const harness = makeHarness([], { provider, tools: [denyTool] });
    const events: AgentEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      events.push(e);
    });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go", bus);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toEqual({
      type: "tool_result",
      id: "call_1",
      name: "deny",
      output: "denied: not allowed",
      isError: true,
    });
  });

  it("falls back to non-streaming chat when provider has no stream", async () => {
    const provider = new MockProvider([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    const harness = makeHarness([], { provider });
    const events: AgentEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      events.push(e);
    });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go", bus);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("falls back to chat when streaming fails", async () => {
    const provider = new FailingStreamProvider([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    const harness = makeHarness([], { provider });
    const events: AgentEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      events.push(e);
    });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go", bus);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    expect(lastAssistantText(messages)).toBe("done");
  });
});
