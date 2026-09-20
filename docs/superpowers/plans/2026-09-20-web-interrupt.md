# Web 前端中断功能实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Web 前端实现「中断 AI 回复」——用户点「停止」后彻底终止当前轮（停生成 + 停后续工具 + 强杀 bash），半成品保留并标记「(已中断)」。

**架构：** 用 `AbortSignal` 从 web-server 的 `SessionManager` 一路贯穿到 `agentLoop` → `provider` → `runBash`。中断时 `agentLoop` 捕获 `TurnCancelledError`（或检测 `signal.aborted`），落盘半成品并广播 `turn_cancelled`，前端 `refresh()` 后展示标记。

**技术栈：** TypeScript / Node 20+ / vitest / OpenAI SDK（`signal` 选项）/ React 18 / Playwright（e2e）。

**规格文档：** `docs/superpowers/specs/2026-09-20-web-interrupt-design.md`

**关键约定（贯穿全文）：**

- 中断只在「模型调用阶段」落盘半成品：`{ role: "assistant", content: partialText, cancelled: true }`。
- 中断在「工具执行阶段 / 下轮循环开头」只广播 `turn_cancelled`（`text` 为空串），不额外落盘（该轮 assistant 消息已 append）。

---

## 任务 0：确认基线

- [ ] **步骤 1：根包测试**

运行：`npx vitest run`
预期：全部 PASS。

- [ ] **步骤 2：子包测试**

运行：`pnpm --filter @blh/web-server exec vitest run` 与 `pnpm --filter @blh/web-client exec vitest run`
预期：全部 PASS。

---

## 任务 1：核心类型 + 事件类型扩展

**文件：**
- 修改：`src/core/types.ts`
- 修改：`src/core/events.ts`
- 修改：`test/integration/helpers.ts`

- [ ] **步骤 1：改 `src/core/types.ts`**

三处：

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** 该条 assistant 消息是否因用户中断而提前结束 */
  cancelled?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): Promise<ChatMessage>;
  stream?(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
}
```

- [ ] **步骤 2：改 `src/core/events.ts`**

`AgentEvent` 增加一条：

```ts
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_cancelled"; text: string }
  | { type: "turn_end" };
```

- [ ] **步骤 3：改 `test/integration/helpers.ts`**

`MockProvider.chat` 加第 4 个参数（忽略即可）：

```ts
export class MockProvider implements ChatProvider {
  calls = 0;
  constructor(private readonly script: ChatMessage[]) {}
  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _maxTokens?: number,
    _signal?: AbortSignal,
  ): Promise<ChatMessage> {
    this.calls += 1;
    const next = this.script.shift();
    if (!next) throw new Error("MockProvider: script exhausted");
    return next;
  }
}
```

- [ ] **步骤 4：类型检查**

运行：`npx tsc --noEmit`
预期：无类型错误。

- [ ] **步骤 5：Commit**

```bash
git add src/core/types.ts src/core/events.ts test/integration/helpers.ts
git commit -m "feat(core): add AbortSignal to provider/tool signatures and turn_cancelled event"
```

---

## 任务 2：`runBash` 支持 signal 强杀

**文件：**
- 修改：`src/tools/bash.ts`
- 修改：`src/tools/registry.ts`
- 修改：`src/tools/index.ts`
- 测试：`test/tools/bash.test.ts`

- [ ] **步骤 1：写失败测试**

在 `test/tools/bash.test.ts` 的 `describe("runBash")` 内新增：

```ts
it("abort 后强杀正在运行的命令并返回 cancelled", async () => {
  const pidFile = path.join(dir, "pid.txt");
  const command = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(()=>{},1000)"`;
  const { runBash } = await import("../../src/tools/bash.js");
  const controller = new AbortController();
  const promise = runBash(dir, 120, 30000, { command }, controller.signal);

  let pid = 0;
  for (let i = 0; i < 50 && pid === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      pid = Number(await fs.readFile(pidFile, "utf8"));
    } catch {
      /* 还没写 */
    }
  }
  expect(pid).toBeGreaterThan(0);

  controller.abort();
  await expect(promise).resolves.toBe("error: command cancelled");

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
}, 15000);
```

- [ ] **步骤 2：运行验证失败**

运行：`npx vitest run test/tools/bash.test.ts`
预期：FAIL——`runBash` 不接收 `signal`，abort 后命令仍在跑，`promise` 一直 pending 直到超时。

- [ ] **步骤 3：改 `src/tools/bash.ts`**

签名加 `signal`，并在 `spawn` 之后注册 abort 监听：

```ts
export function runBash(
  workdir: string,
  defaultTimeout: number,
  maxOutputChars: number,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof args.command !== "string") throw new TypeError("command must be a string");
  const command = args.command;
  const timeoutSec = typeof args.timeout === "number" ? args.timeout : defaultTimeout;

  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(shell, shellArgs, {
      cwd: workdir,
      detached: process.platform !== "win32",
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      void killTree(child).then(() => resolve("error: command cancelled"));
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(`error: ${error.message}`);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const combinedOutput = stdout + (stderr ? `\n(stderr):\n${stderr}` : "");
      const exitCode = typeof code === "number" ? code : 1;
      resolve(formatBashOutput(combinedOutput, exitCode, maxOutputChars));
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void killTree(child).then(() =>
        resolve(`error: command timed out after ${timeoutSec}s`),
      );
    }, timeoutSec * 1000 + 50);
    timer.unref();
  });
}
```

（`killTree` 与 `formatBashOutput` 保持不变。）

- [ ] **步骤 4：改 `src/tools/registry.ts` 的 `dispatch`**

```ts
async dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const tool = this.tools.get(name);
  if (!tool) return `error: unknown tool '${name}'`;
  try {
    return await tool.handler(args, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof TypeError) return `error: invalid tool arguments: ${message}`;
    return `error: tool '${name}' failed: ${message}`;
  }
}
```

- [ ] **步骤 5：改 `src/tools/index.ts` 的 bash handler**

```ts
handler: (args, signal) => runBash(workdir, config.bashTimeout, config.maxOutputChars, args, signal),
```

- [ ] **步骤 6：运行验证通过**

运行：`npx vitest run test/tools/bash.test.ts`
预期：全部 PASS（含新加 abort 强杀测试）。

- [ ] **步骤 7：Commit**

```bash
git add src/tools/bash.ts src/tools/registry.ts src/tools/index.ts test/tools/bash.test.ts
git commit -m "feat(tools): support AbortSignal to force-kill bash on cancel"
```

---

## 任务 3：`OpenAIProvider` 透传 signal

**文件：**
- 修改：`src/providers/openai.ts`
- 测试：`test/providers/openai.test.ts`

- [ ] **步骤 1：写失败测试**

在 `test/providers/openai.test.ts` 的 `describe("OpenAIProvider")` 内新增：

```ts
it("passes signal through to chat.completions.create", async () => {
  const { OpenAIProvider } = await import("../../src/providers/openai.js");
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { role: "assistant", content: "hi" } }] });
  const provider = new OpenAIProvider(config, makeClient(create));
  const controller = new AbortController();
  await provider.chat([{ role: "user", content: "hi" }], [], undefined, controller.signal);
  expect(create).toHaveBeenCalledWith(expect.anything(), {
    timeout: 600_000,
    signal: controller.signal,
  });
});

it("passes signal through in stream", async () => {
  const { OpenAIProvider } = await import("../../src/providers/openai.js");
  const create = vi.fn().mockResolvedValue(
    (async function* () {
      yield { choices: [{ index: 0, delta: { content: "hi" } }] };
    })(),
  );
  const provider = new OpenAIProvider(config, makeClient(create));
  const controller = new AbortController();
  for await (const _ of provider.stream!([{ role: "user", content: "hi" }], [], undefined, controller.signal)) {
    /* 消费完 */
  }
  expect(create).toHaveBeenCalledWith(expect.anything(), {
    timeout: 600_000,
    signal: controller.signal,
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`npx vitest run test/providers/openai.test.ts`
预期：FAIL——`create` 未收到 `signal`（options 里没有 `signal` 字段）。

- [ ] **步骤 3：改 `src/providers/openai.ts`**

1. `ChatCompletionsClient` 两个 `create` 重载的 options 都加 `signal`：

```ts
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        params: OpenAI.ChatCompletionCreateParamsNonStreaming,
        options?: { timeout?: number; signal?: AbortSignal },
      ): Promise<OpenAI.ChatCompletion>;
      create(
        params: OpenAI.ChatCompletionCreateParamsStreaming,
        options?: { timeout?: number; signal?: AbortSignal },
      ): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
    };
  };
}
```

2. `createCompletion` 加 signal 并透传：

```ts
private async createCompletion(
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
  signal?: AbortSignal,
): Promise<OpenAI.ChatCompletion> {
  return withRetry(() =>
    this.client.chat.completions.create(params, { timeout: 600_000, signal }),
  );
}
```

3. `chat` 签名加 `signal`，`createCompletion({ ... })` 调用改为 `createCompletion({ ... }, signal)`：

```ts
async chat(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens?: number,
  signal?: AbortSignal,
): Promise<ChatMessage> {
  log.debug("chat request", { model: this.config.model, messages: messages.length, tools: tools.length });
  const response = await this.createCompletion(
    {
      model: this.config.model,
      messages: messages.map(toOpenAIMessage),
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    },
    signal,
  );
  const message = response.choices[0]?.message;
  if (!message) throw new Error("provider returned no choices");
  log.debug("chat response", { toolCalls: message.tool_calls?.length ?? 0 });
  return fromOpenAIMessage(message);
}
```

4. `stream` 签名加 `signal`，`create(..., { timeout: 600_000 })` 改为 `create(..., { timeout: 600_000, signal })`：

```ts
async *stream(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens?: number,
  signal?: AbortSignal,
): AsyncIterable<ProviderStreamEvent> {
  log.debug("stream request", { model: this.config.model, messages: messages.length, tools: tools.length });
  const stream = await withRetry(() =>
    this.client.chat.completions.create(
      {
        model: this.config.model,
        messages: messages.map(toOpenAIMessage),
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      },
      { timeout: 600_000, signal },
    ),
  );

  // ...（下方 for await 循环体保持不变）
}
```

（`chatCompletion` 不加 signal，保持不变。）

- [ ] **步骤 4：运行验证通过**

运行：`npx vitest run test/providers/openai.test.ts`
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/providers/openai.ts test/providers/openai.test.ts
git commit -m "feat(provider): pass AbortSignal through to OpenAI SDK"
```

---

## 任务 4：`agentLoop` 支持中断 + `Harness.runTurn` 透传

**文件：**
- 修改：`src/core/loop.ts`
- 修改：`src/core/harness.ts`
- 测试：`test/core/loop.test.ts`

- [ ] **步骤 1：写失败测试**

在 `test/core/loop.test.ts` 的 `StreamingProvider` 附近新增一个可中断 provider：

```ts
class CancellableStreamProvider implements ChatProvider {
  constructor(private readonly script: ChatMessage[]) {}

  async chat(): Promise<ChatMessage> {
    throw new Error("CancellableStreamProvider.chat unused");
  }

  async *stream(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _maxTokens?: number,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent> {
    const message = this.script.shift();
    if (!message) throw new Error("CancellableStreamProvider: script exhausted");
    if (message.content) yield { type: "text_delta", text: message.content };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }
}
```

在 `describe("agentLoop")` 内新增两个用例（时机 A、时机 B）：

```ts
it("流式生成中被中断：落盘半成品并广播 turn_cancelled", async () => {
  const provider = new CancellableStreamProvider([makeTextMessage("你好，我是")]);
  const harness = makeHarness([], { provider });
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "loop-cancel-"));
  harness.sessionStore = SessionStore.create(tmpDir);
  const events: AgentEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const controller = new AbortController();
  const messages = harness.newSession();
  const run = harness.runTurn(messages, "go", bus, controller.signal);
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await run;

  expect(events.map((e) => e.type)).toContain("turn_cancelled");
  const cancelled = events.find((e) => e.type === "turn_cancelled");
  expect((cancelled as { text: string }).text).toBe("你好，我是");
  const last = messages[messages.length - 1]!;
  expect(last.cancelled).toBe(true);
  expect(last.content).toBe("你好，我是");
  expect(SessionStore.load(tmpDir).some((m) => m.cancelled === true)).toBe(true);
});

it("工具执行后被中断：广播 turn_cancelled 且不再继续循环", async () => {
  let abortSeen = false;
  const slowTool: ToolDefinition = {
    name: "slow",
    description: "",
    parameters: { type: "object" },
    handler: async (_args, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          abortSeen = true;
          resolve();
        }, { once: true });
      });
      return "error: command cancelled";
    },
  };
  const harness = makeHarness(
    [makeToolCallMessage("slow", {}), makeTextMessage("should not appear")],
    { tools: [slowTool] },
  );
  const events: AgentEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const controller = new AbortController();
  const messages = harness.newSession();
  const run = harness.runTurn(messages, "go", bus, controller.signal);
  const deadline = Date.now() + 1000;
  while (!events.some((e) => e.type === "tool_call") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  controller.abort();
  await run;

  expect(abortSeen).toBe(true);
  expect(events.map((e) => e.type)).toContain("turn_cancelled");
  expect(lastAssistantText(messages)).not.toBe("should not appear");
});
```

- [ ] **步骤 2：运行验证失败**

运行：`npx vitest run test/core/loop.test.ts`
预期：FAIL——`runTurn` 无第 4 个参数（vitest 用 esbuild 转译不做类型检查，运行后 signal 未生效，`turn_cancelled` 事件不会广播，断言失败）。

- [ ] **步骤 3：改 `src/core/loop.ts`**

1. 顶部 `const log = ...` 之后新增 `TurnCancelledError`：

```ts
/** 用户主动中断当前轮时抛出，携带已生成的半成品文字。 */
export class TurnCancelledError extends Error {
  constructor(readonly partialText: string) {
    super("turn cancelled");
    this.name = "TurnCancelledError";
  }
}
```

2. `agentLoop` 签名加 `signal`：

```ts
export async function agentLoop(
  harness: Harness,
  messages: ChatMessage[],
  activeRequest = "",
  events?: EventBus,
  signal?: AbortSignal,
): Promise<void> {
```

3. 在 `for (;;) {` 之后、`log.debug("turn start", ...)` 之前加中断检查：

```ts
for (;;) {
  if (signal?.aborted) {
    await events?.emit({ type: "turn_cancelled", text: "" });
    return;
  }
  log.debug("turn start", { messages: messages.length });
```

4. 模型调用 try 块内，`streamAssistantMessage` 加 `signal`，非流式 `chat` 加 `signal`，流式回退分支先透传 `TurnCancelledError`：

```ts
    try {
      if (streamAvailable) {
        try {
          message = await streamAssistantMessage(harness.provider, messages, harness.tools.list(), events, signal);
        } catch (error) {
          if (error instanceof TurnCancelledError) throw error;
          log.warn("stream failed, falling back to non-streaming", {
            error: error instanceof Error ? error.message : String(error),
          });
          message = await harness.provider.chat(messages, harness.tools.list(), undefined, signal);
        }
      } else {
        message = await harness.provider.chat(messages, harness.tools.list(), undefined, signal);
      }
      reactiveRetries = 0;
    } catch (error) {
      if (error instanceof TurnCancelledError) {
        const partial: ChatMessage = { role: "assistant", content: error.partialText, cancelled: true };
        messages.push(partial);
        harness.sessionStore?.append(partial);
        await events?.emit({ type: "turn_cancelled", text: error.partialText });
        return;
      }
      if (signal?.aborted) {
        const partial: ChatMessage = { role: "assistant", content: "", cancelled: true };
        messages.push(partial);
        harness.sessionStore?.append(partial);
        await events?.emit({ type: "turn_cancelled", text: "" });
        return;
      }
      if (compactor && isPromptTooLong(error) && reactiveRetries < MAX_REACTIVE_RETRIES) {
        const compacted = await compactor.reactiveCompact(messages, activeRequest);
        messages.splice(0, messages.length, ...compacted);
        restoreSystem(messages, systemMessage);
        reactiveRetries += 1;
        continue;
      }
      throw error;
    }
```

5. 工具循环里 `harness.tools.dispatch(name, input)` 改为 `harness.tools.dispatch(name, input, signal)`。

6. 工具 for 循环结束后（`for (const call of toolCalls) { ... }` 的右花括号后、`const todoManager = harness.todoManager;` 之前）加中断检查：

```ts
    if (signal?.aborted) {
      await events?.emit({ type: "turn_cancelled", text: "" });
      return;
    }
```

7. `streamAssistantMessage` 加 `signal` 参数并累加 partialText：

```ts
async function streamAssistantMessage(
  provider: ChatProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  events: EventBus,
  signal?: AbortSignal,
): Promise<ChatMessage> {
  const stream = provider.stream!(messages, tools, undefined, signal);
  let partialText = "";
  try {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        partialText += event.text;
        await events.emit({ type: "assistant_text_delta", text: event.text });
      } else if (event.type === "done") {
        return event.message;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new TurnCancelledError(partialText);
    throw error;
  }
  throw new Error("provider stream ended without a done event");
}
```

- [ ] **步骤 4：改 `src/core/harness.ts` 的 `runTurn`**

签名加 `signal` 并透传给 `agentLoop`：

```ts
async runTurn(messages: ChatMessage[], text: string, events?: EventBus, signal?: AbortSignal): Promise<void> {
  await this.hooks.trigger(USER_PROMPT_SUBMIT, { text });
  const userMessage: ChatMessage = { role: "user", content: text };
  messages.push(userMessage);
  this.sessionStore?.append(userMessage);
  const systemMessage = messages[0];
  if (this.memory && systemMessage) {
    systemMessage.content = await this.fullSystemPrompt(messages);
  }
  await agentLoop(this, messages, text, events, signal);
  await this.hooks.trigger(STOP, {});
  if (this.memory && (await this.memory.extract(messages))) {
    await this.memory.consolidate();
  }
}
```

- [ ] **步骤 5：运行验证通过**

运行：`npx vitest run test/core/loop.test.ts`
预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/core/loop.ts src/core/harness.ts test/core/loop.test.ts
git commit -m "feat(core): support aborting agentLoop mid-turn with partial-text persistence"
```

---

## 任务 5：`SessionManager.stop` + `/api/stop` 端点

**文件：**
- 修改：`apps/web-server/src/types.ts`
- 修改：`apps/web-server/src/session.ts`
- 修改：`apps/web-server/src/http.ts`
- 测试：`apps/web-server/test/session.test.ts`、`apps/web-server/test/http.test.ts`

- [ ] **步骤 1：改 `apps/web-server/src/types.ts`**

三处：

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  cancelled?: boolean;
}

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_cancelled"; text: string }
  | { type: "turn_end" };

export interface WebTurnRunner {
  newSession(): ChatMessage[];
  runTurn(messages: ChatMessage[], text: string, events?: WebEventBus, signal?: AbortSignal): Promise<void>;
  sessionStore?: SessionStoreLike | undefined;
}
```

- [ ] **步骤 2：写 `SessionManager.stop` 失败测试**

在 `apps/web-server/test/session.test.ts` 内新增：

```ts
it("stop 在无运行轮次时返回 false", () => {
  const manager = new SessionManager(fakeRunner(), fakeLock(), () => {}, new ApprovalCoordinator(() => {}), makeTestSessionStore());
  manager.create(tmpDir);
  expect(manager.stop()).toBe(false);
});

it("stop 触发正在运行轮次的 signal", async () => {
  let seenSignal: AbortSignal | undefined;
  const runner: WebTurnRunner = {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: vi.fn(async (_messages, _text, _events, signal) => {
      seenSignal = signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    }),
  };
  const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}), makeTestSessionStore());
  const handle = manager.create(tmpDir);
  const run = manager.runTurn(handle.id, "hi");
  await new Promise((r) => setTimeout(r, 10));
  expect(manager.stop()).toBe(true);
  expect(seenSignal?.aborted).toBe(true);
  await run;
});
```

- [ ] **步骤 3：运行验证失败**

运行：`pnpm --filter @blh/web-server exec vitest run test/session.test.ts`
预期：FAIL——`manager.stop` 不存在。

- [ ] **步骤 4：改 `apps/web-server/src/session.ts`**

`SessionManager` 增加 `currentAbort` 字段，`runTurn` 创建 controller，新增 `stop`：

```ts
export class SessionManager {
  private current: SessionHandle | undefined;
  private currentAbort: AbortController | null = null;

  // ...构造器与其它方法不变

  runTurn(id: string, text: string): Promise<void> {
    const handle = this.get(id);
    if (handle === undefined) return Promise.reject(new Error(`no such session: ${id}`));
    const events = new EventBus();
    const off = events.subscribe((event) => this.broadcast(event));
    const controller = new AbortController();
    this.currentAbort = controller;
    const run = () => this.runner.runTurn(handle.messages, text, events, controller.signal);
    log.debug("run turn", { id, textLength: text.length });
    return this.lock.withLock(run).finally(() => {
      off();
      if (this.currentAbort === controller) this.currentAbort = null;
    });
  }

  /** 中断当前正在运行的轮次；没有运行中的轮次则返回 false。 */
  stop(): boolean {
    if (this.currentAbort === null) return false;
    this.currentAbort.abort();
    return true;
  }
```

- [ ] **步骤 5：运行验证通过**

运行：`pnpm --filter @blh/web-server exec vitest run test/session.test.ts`
预期：全部 PASS。

- [ ] **步骤 6：写 `/api/stop` 失败测试**

在 `apps/web-server/test/http.test.ts` 内新增：

```ts
it("POST /api/stop 返回 200 ok", async () => {
  const { server, url } = await listen(makeContext(tmpDir));
  servers.push(server);
  const res = await fetch(`${url}/api/stop`, { method: "POST", headers: { "x-blh-web": "1" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("POST /api/stop 缺少 CSRF 头返回 403", async () => {
  const { server, url } = await listen(makeContext(tmpDir));
  servers.push(server);
  const res = await fetch(`${url}/api/stop`, { method: "POST" });
  expect(res.status).toBe(403);
});
```

- [ ] **步骤 7：运行验证失败**

运行：`pnpm --filter @blh/web-server exec vitest run test/http.test.ts`
预期：FAIL——`/api/stop` 返回 404。

- [ ] **步骤 8：改 `apps/web-server/src/http.ts`**

在 `handleApi` 中 `/api/approval` 分支之前插入：

```ts
  if (method === "POST" && pathname === "/api/stop") {
    ctx.session.stop();
    json(res, 200, { ok: true });
    return;
  }
```

- [ ] **步骤 9：运行验证通过**

运行：`pnpm --filter @blh/web-server exec vitest run test/http.test.ts`
预期：全部 PASS。

- [ ] **步骤 10：Commit**

```bash
git add apps/web-server/src/types.ts apps/web-server/src/session.ts apps/web-server/src/http.ts apps/web-server/test/session.test.ts apps/web-server/test/http.test.ts
git commit -m "feat(web-server): add /api/stop endpoint and SessionManager.stop"
```

---

## 任务 6：前端——web-client + useAgentEvents + 组件

**文件：**
- 修改：`packages/web-client/src/types.ts`
- 修改：`packages/web-client/src/api.ts`
- 修改：`apps/web/src/hooks/useAgentEvents.ts`
- 修改：`apps/web/src/components/InputBar.tsx`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/components/turns.ts`
- 修改：`apps/web/src/components/ChatPanel.tsx`
- 测试：`packages/web-client/test/api.test.ts`

- [ ] **步骤 1：改 `packages/web-client/src/types.ts`**

`ChatMessage` 加 `cancelled`，`AgentEvent` 加 `turn_cancelled`：

```ts
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_cancelled"; text: string }
  | { type: "turn_end" };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
  cancelled?: boolean;
}
```

- [ ] **步骤 2：写 `stopMessage` 失败测试**

在 `packages/web-client/test/api.test.ts` 中，import 加 `stopMessage`，并新增：

```ts
it("stopMessage 发送 POST /api/stop", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  await stopMessage();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/stop");
  expect(init.method).toBe("POST");
});
```

- [ ] **步骤 3：运行验证失败**

运行：`pnpm --filter @blh/web-client exec vitest run test/api.test.ts`
预期：FAIL——`stopMessage` 未导出。

- [ ] **步骤 4：改 `packages/web-client/src/api.ts` 新增 `stopMessage`**

```ts
export function stopMessage(): Promise<unknown> {
  return request("/api/stop", { method: "POST" });
}
```

- [ ] **步骤 5：运行验证通过**

运行：`pnpm --filter @blh/web-client exec vitest run test/api.test.ts`
预期：全部 PASS。

- [ ] **步骤 6：改 `apps/web/src/hooks/useAgentEvents.ts`**

1. import 里加 `stopMessage`：

```ts
import {
  connectEvents,
  deleteSession as deleteSessionApi,
  getSession,
  listSessions,
  newSession,
  respondApproval,
  resumeSession,
  sendMessage,
  stopMessage,
  type ApprovalDecision,
  type ChatMessage,
  type SessionListItem,
} from "@blh/web-client";
```

2. `AgentState` 接口加 `stop` 与 `canStop`：

```ts
export interface AgentState {
  // ...现有字段不变
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  canStop: boolean;
  respond(decision: ApprovalDecision): Promise<void>;
  // ...
}
```

3. SSE switch 里，`turn_end` 分支之后加 `turn_cancelled`：

```ts
case "turn_cancelled":
  setBusy(false);
  setStreaming("");
  streamBuf.current = [];
  setToolEvents([]);
  void refresh();
  break;
```

4. 新增 `stop` 回调（放在 `send` 回调之后）：

```ts
const stop = useCallback(async () => {
  try {
    await stopMessage();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    log.error("stop failed", {}, e);
  }
}, []);
```

5. return 里加：

```ts
send,
stop,
canStop: busy && approval === null,
respond,
```

- [ ] **步骤 7：改 `apps/web/src/components/InputBar.tsx`**

```tsx
import { useState } from "react";

export function InputBar(props: {
  busy: boolean;
  canStop: boolean;
  onSend(text: string): void;
  onStop(): void;
}) {
  const { busy, canStop, onSend, onStop } = props;
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (t === "") return;
    setText("");
    onSend(t);
  }

  return (
    <form
      className="input-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入消息…"
        disabled={busy}
      />
      {canStop ? (
        <button type="button" className="stop" onClick={() => onStop()}>
          停止
        </button>
      ) : (
        <button type="submit" disabled={busy || text.trim() === ""}>
          发送
        </button>
      )}
    </form>
  );
}
```

- [ ] **步骤 8：改 `apps/web/src/App.tsx`**

```tsx
<InputBar
  busy={state.busy}
  canStop={state.canStop}
  onSend={(text) => void state.send(text)}
  onStop={() => void state.stop()}
/>
```

- [ ] **步骤 9：改 `apps/web/src/components/turns.ts`**

`groupMessages` 里 final 选择逻辑，把 `cancelled` 的 assistant（即使 content 为空）也作为 final：

```ts
    let finalIdx = -1;
    for (let i = 1; i < seg.length; i++) {
      const m = seg[i]!;
      if (m.role === "assistant" && ((m.content ?? "").trim() !== "" || m.cancelled === true)) {
        finalIdx = i;
      }
    }
```

- [ ] **步骤 10：改 `apps/web/src/components/ChatPanel.tsx`**

assistant 气泡里加 `(已中断)` 标记：

```tsx
{/* 第 53-58 行的 assistant 气泡改为： */}
{turn.final !== null && (
  <div className="bubble bubble-assistant">
    <span className="bubble-role">assistant</span>
    <span className="bubble-text">
      {turn.final.content ?? ""}
      {turn.final.cancelled ? <span className="cancelled-mark">(已中断)</span> : null}
    </span>
  </div>
)}
```

- [ ] **步骤 11：类型检查**

运行：`npx tsc --noEmit`、`pnpm --filter @blh/web typecheck`、`pnpm --filter @blh/web-client typecheck`
预期：无类型错误。

- [ ] **步骤 12：Commit**

```bash
git add packages/web-client/src/types.ts packages/web-client/src/api.ts packages/web-client/test/api.test.ts apps/web/src/hooks/useAgentEvents.ts apps/web/src/components/InputBar.tsx apps/web/src/App.tsx apps/web/src/components/turns.ts apps/web/src/components/ChatPanel.tsx
git commit -m "feat(web): add stop button and turn_cancelled handling"
```

---

## 任务 7：e2e 测试

**文件：**
- 修改：`apps/web/e2e/mock-server.mjs`
- 修改：`apps/web/e2e/workbench.spec.ts`

- [ ] **步骤 1：改 `apps/web/e2e/mock-server.mjs`**

在 `/api/message` 分支的 `else` 之前加「中断」场景，并新增 `/api/stop` 端点：

```js
    } else if (text.includes("中断")) {
      broadcast("turn_start");
      broadcast("assistant_text_delta", { text: "你好" });
      // 不广播 turn_end，保持 busy，让前端显示「停止」按钮
    }
```

```js
  if (method === "POST" && pathname === "/api/stop") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    messages.push({ role: "assistant", content: "你好", cancelled: true });
    broadcast("turn_cancelled", { text: "你好" });
    return;
  }
```

- [ ] **步骤 2：改 `apps/web/e2e/workbench.spec.ts` 新增用例**

```ts
test("回复中显示停止按钮，点击后中断并标记已中断", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("请中断");
  await page.getByRole("button", { name: "发送" }).click();
  const stopButton = page.getByRole("button", { name: "停止" });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(page.getByText("(已中断)")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
});
```

- [ ] **步骤 3：运行 e2e**

（确保 mock-server 已在 8123 启动；沿用现有 e2e 启动方式）

运行：`pnpm --filter @blh/web test:e2e`
预期：全部 PASS（含新增用例）。

- [ ] **步骤 4：Commit**

```bash
git add apps/web/e2e/mock-server.mjs apps/web/e2e/workbench.spec.ts
git commit -m "test(web): e2e cover stop button and cancelled marker"
```

---

## 最终验证

- [ ] **步骤 1：全部单测**

运行：`npx vitest run`、`pnpm --filter @blh/web-server exec vitest run`、`pnpm --filter @blh/web-client exec vitest run`
预期：全部 PASS。

- [ ] **步骤 2：e2e**

运行：`pnpm --filter @blh/web test:e2e`
预期：全部 PASS。

- [ ] **步骤 3：整体 typecheck**

运行：`npx tsc --noEmit`
预期：无类型错误。
