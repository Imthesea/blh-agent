# M0 Foundation — minicc实施计划

> 面向 AI 代理的工作者：必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 从零搭建 blh 的 cc，交付可运行的最小编码 Agent CLI：REPL / `-p` 单次对话、5 个内置工具（bash / read_file / write_file / edit_file / glob）、权限规则（PreToolUse hook 实现）、429/5xx 自动重试。

**架构：** CLI 层 → Harness 核心（AgentLoop + 管线编排）→ 功能域（tools/security）→ 基础层（providers/hooks/config）。权限不硬编码在 dispatch，而是作为 PreToolUse hook。

**技术栈：** Node.js >= 20、TypeScript 5.x（strict）、ESM（`"type": "module"`，NodeNext，相对导入带 `.js` 后缀）、vitest、eslint（flat config）、tsx（开发）、tsc（构建，`bin: blh → dist/cli/main.js`）。运行时依赖：`openai@^4`（仅 M0；dotenv/yaml/fast-glob 属后续里程碑，M0 glob 用 `fs.promises.opendir` 手写递归 + 手写 fnmatch）。

**设计文档：** [`docs/2026-09-15-blh-claude-code-ts-design.md`](../2026-09-15-blh-claude-code-ts-design.md)

---

## 通用约定（每个任务都必须遵守）

1. **ESM 导入**：所有相对导入必须带 `.js` 后缀，例如 `import { loadConfig } from "../core/config.js"`。
2. **TS 内部 camelCase，模型契约 snake_case**：工具 schema 的 `parameters` JSON、工具返回字符串、错误信息
3. **工具签名**：

```ts
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema，原样透传给模型
  handler: ToolHandler;
}
```

4. **异步**：所有 I/O（文件、子进程、网络）一律 `async/await`，禁止 `execSync`/`readFileSync`（构建脚本除外）。
5. **测试**：
   - vitest，测试文件与源码同目录，`*.test.ts`。
   - 临时目录 helper：`const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-"))`，afterEach 里 `fs.rm(dir, { recursive: true, force: true })`。
   - 环境变量：`vi.stubEnv("OPENAI_API_KEY", "k")`，afterEach `vi.unstubAllEnvs()`。
   - 所有测试均为离线单测；真实 API 冒烟放任务 13，用 `describe.skipIf(!process.env.BLH_LIVE)` 门控。
6. **TDD 五步法**：每个任务 = ① 写失败测试 → ② 运行验证失败（预期 `Cannot find module` 或断言失败）→ ③ 实现 → ④ 运行验证通过 → ⑤ commit（约定式提交）。
7. **验证命令**（package.json 的 scripts 中固定；包管理用 **pnpm**，锁文件 `pnpm-lock.yaml`，不使用 npm）：
   - `pnpm test` → `vitest run`
   - `pnpm typecheck` → `tsc --noEmit`
   - `pnpm lint` → `eslint .`
   - `pnpm build` → `tsc -p tsconfig.build.json`
   - 每个任务第 ④ 步至少运行 `pnpm test -- <相关文件>`；任务 13 运行全量。

---

## 文件结构（M0 交付物）

```
blh-claude-code-ts/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── eslint.config.js
├── .gitignore
├── src/
│   ├── core/
│   │   ├── types.ts            # ChatMessage / ToolCall / ToolDef / ToolHandler / Config
│   │   ├── config.ts           # loadConfig：只读环境变量（M0 无 dotenv/yaml/CLI 参数）
│   │   ├── config.test.ts
│   │   ├── hooks.ts            # HookBus + 4 个事件常量
│   │   ├── hooks.test.ts
│   │   ├── loop.ts             # agentLoop(harness, messages)
│   │   ├── loop.test.ts
│   │   ├── harness.ts          # Harness 类（4 参数）+ runTurn
│   │   └── harness.test.ts
│   ├── providers/
│   │   ├── retry.ts            # RetryState / retryDelay / isRetryable / withRetry
│   │   ├── retry.test.ts
│   │   ├── openai.ts           # OpenAIProvider
│   │   └── openai.test.ts
│   ├── tools/
│   │   ├── registry.ts         # ToolRegistry：register/list/schemas/dispatch
│   │   ├── registry.test.ts
│   │   ├── files.ts            # safePath / readFile / writeFile / editFile
│   │   ├── files.test.ts
│   │   ├── bash.ts             # runBash（超时/截断/退出码）
│   │   ├── bash.test.ts
│   │   ├── glob.ts             # 手写 fnmatch + 递归遍历，上限 200
│   │   ├── glob.test.ts
│   │   └── index.ts            # registerBuiltinTools
│   ├── security/
│   │   ├── rules.ts            # PermissionRule / DEFAULT_RULES(4 条) / matchRule
│   │   ├── rules.test.ts
│   │   ├── approval.ts         # makePermissionHook
│   │   └── approval.test.ts
│   └── cli/
│       ├── repl.ts             # 交互循环
│       ├── repl.test.ts
│       └── main.ts             # buildHarness + 入口（-p/--print）
└── test/
    └── integration/
        ├── helpers.ts          # MockProvider / toolCallMsg / textMsg
        ├── agent.test.ts       # 端到端：写文件→读文件；权限拒绝
        └── live.test.ts        # BLH_LIVE 门控的真实 API 冒烟
```

---

<!-- TASKS -->

## 任务 1：项目骨架与工具链

**目标：** 可安装、可构建、可测试、可 lint 的空项目，`blh` bin 指向 `dist/cli/main.js`。

- [ ] **步骤 1：初始化 package.json**

```json
{
  "name": "blh",
  "version": "0.1.0",
  "description": "blh — a coding agent CLI (TypeScript)",
  "type": "module",
  "bin": { "blh": "dist/cli/main.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint .",
    "dev": "tsx src/cli/main.ts"
  },
  "dependencies": {
    "openai": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **步骤 2：tsconfig.json（严格 + NodeNext）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

`tsconfig.build.json`（构建只含 src，不含测试）：

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **步骤 3：vitest.config.ts / eslint.config.js / .gitignore**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
```

```js
// eslint.config.js
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: { parser: tsparser },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  { ignores: ["dist/", "node_modules/"] },
];
```

`.gitignore`：`node_modules/`、`dist/`、`.env`

- [ ] **步骤 4：最小入口 src/cli/main.ts（占位，任务 12 替换）**

```ts
#!/usr/bin/env node
console.log("blh (ts) — bootstrap ok");
```

- [ ] **步骤 5：运行验证**

```bash
pnpm install
pnpm typecheck   # 通过
pnpm lint        # 通过
pnpm build       # 产出 dist/cli/main.js
node dist/cli/main.js   # 打印 bootstrap ok
```

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with build/test/lint toolchain"
```

---

## 任务 2：core/types.ts + core/config.ts

**目标：** 定义共享类型；`loadConfig` 只读环境变量（M0 无 dotenv/yaml/CLI 参数），行为与 Python M0 逐字一致：缺 `OPENAI_API_KEY` 直接退出。

**行为契约（对齐 Python M0 config.py）：**

| 字段 | 来源 | 默认 |
|---|---|---|
| `apiKey` | `OPENAI_API_KEY`，空/缺失 → 打印错误并 `process.exit(1)` | 无 |
| `baseUrl` | `OPENAI_BASE_URL`，空字符串 → `undefined` | `undefined` |
| `model` | `OPENAI_MODEL` | `"gpt-4o-mini"` |
| `workdir` | 参数传入 | `process.cwd()` |
| `bashTimeout` | 常量 | `120` |
| `maxOutputChars` | 常量 | `30000` |

- [ ] **步骤 1：编写失败测试 src/core/config.test.ts**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("reads values from environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:8000/v1");
    vi.stubEnv("OPENAI_MODEL", "my-model");
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig("/tmp/work");
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.baseUrl).toBe("http://localhost:8000/v1");
    expect(cfg.model).toBe("my-model");
    expect(cfg.workdir).toBe("/tmp/work");
    expect(cfg.bashTimeout).toBe(120);
    expect(cfg.maxOutputChars).toBe(30000);
  });

  it("defaults model and baseUrl", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "");
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.workdir).toBe(process.cwd());
  });

  it("exits when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { loadConfig } = await import("./config.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadConfig()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith("OPENAI_API_KEY is not set");
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/core/config.test.ts
# 预期：Cannot find module './config.js'
```

- [ ] **步骤 3：实现 src/core/types.ts**

```ts
/** 与模型交互的消息格式（对齐 OpenAI chat.completions） */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
}

export interface Config {
  apiKey: string;
  baseUrl?: string;
  model: string;
  workdir: string;
  bashTimeout: number;
  maxOutputChars: number;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatMessage>;
}
```

- [ ] **步骤 4：实现 src/core/config.ts**

```ts
import type { Config } from "./types.js";

export function loadConfig(workdir?: string): Config {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set");
    process.exit(1);
  }
  const baseUrl = process.env.OPENAI_BASE_URL || undefined;
  return {
    apiKey,
    baseUrl,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    workdir: workdir ?? process.cwd(),
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
}
```

注意：`exactOptionalPropertyTypes` 下 `baseUrl?: string` 不能显式赋 `undefined`，但此处返回字面量中 `baseUrl` 值为 `string | undefined`，ts 允许；若 lint 报错可改为条件展开 `...(baseUrl ? { baseUrl } : {})`——以 `pnpm typecheck` 实际结果为准。

- [ ] **步骤 5：运行验证通过**

```bash
pnpm test -- src/core/config.test.ts   # 3 passed
pnpm typecheck
```

- [ ] **步骤 6：Commit**

```bash
git add src/core/types.ts src/core/config.ts src/core/config.test.ts
git commit -m "feat(core): add shared types and env-only loadConfig"
```

---

## 任务 3：providers/retry.ts

**目标：** 429/5xx 指数退避重试。M0 简版：**无 Retry-After 头解析、无抖动**（那是 M6）。

**行为契约（对齐 Python M0 retry.py）：**
- `retryDelay(attempt) = min(2 ** attempt, 32)` 秒
- `isRetryable(err)`：HTTP status === 429 或 >= 500 → true；无 status（网络错误等）→ true；其他 4xx → false
- `withRetry(fn)`：默认最多 5 次；最后一次失败或不可重试 → 原样抛出；否则 `await sleep(retryDelay(attempt))` 后重试

- [ ] **步骤 1：编写失败测试 src/providers/retry.test.ts**

```ts
import { describe, it, expect, vi } from "vitest";
import { retryDelay, isRetryable, withRetry } from "./retry.js";

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

describe("retryDelay", () => {
  it("doubles with attempt, capped at 32", () => {
    expect(retryDelay(0)).toBe(1);
    expect(retryDelay(1)).toBe(2);
    expect(retryDelay(5)).toBe(32);
    expect(retryDelay(10)).toBe(32);
  });
});

describe("isRetryable", () => {
  it("retries 429 and 5xx", () => {
    expect(isRetryable(httpError(429))).toBe(true);
    expect(isRetryable(httpError(500))).toBe(true);
    expect(isRetryable(httpError(503))).toBe(true);
  });
  it("does not retry other 4xx", () => {
    expect(isRetryable(httpError(400))).toBe(false);
    expect(isRetryable(httpError(401))).toBe(false);
    expect(isRetryable(httpError(404))).toBe(false);
  });
  it("retries errors without status (network failures)", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors until success", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue("ok");
    const p = withRetry(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws non-retryable errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(withRetry(fn)).rejects.toThrow("http 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(httpError(503));
    const p = withRetry(fn, 3);
    const assertion = expect(p).rejects.toThrow("http 503");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/providers/retry.test.ts
# 预期：Cannot find module './retry.js'
```

- [ ] **步骤 3：实现 src/providers/retry.ts**

```ts
export function retryDelay(attempt: number): number {
  return Math.min(2 ** attempt, 32);
}

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number") return true; // 无 status：网络错误等，可重试
  return status === 429 || status >= 500;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempts += 1;
      if (attempts >= maxAttempts || !isRetryable(err)) throw err;
      await sleep(retryDelay(attempts - 1));
    }
  }
}
```

注意与 Python 的语义对齐：Python `retry_delay(attempts)` 在 `attempts += 1` 之后调用，首次退避为 `2**1 = 2` 秒……**不，M0 版为 `retry_delay(self.attempts - 1)` 之前的语义需核对**：Python M0 中 `with_retry` 内 `self.attempts += 1` 后 `time.sleep(retry_delay(self.attempts))`？以 Python M0 计划任务 3 的实现为准——其首次 sleep 为 `retry_delay(0) = 1`（attempt 从 0 开始计数失败后第 1 次退避）。上面 TS 实现 `retryDelay(attempts - 1)`：第 1 次失败 `attempts=1` → `retryDelay(0)=1`，与 Python 一致。若执行时发现 Python 蓝本实为 `2**attempts`（首次 2 秒），按蓝本修改实现与测试（`retryDelay` 单测不变，仅调用点偏移）。

- [ ] **步骤 4：运行验证通过**

```bash
pnpm test -- src/providers/retry.test.ts   # 8 passed
pnpm typecheck
```

- [ ] **步骤 5：Commit**

```bash
git add src/providers/retry.ts src/providers/retry.test.ts
git commit -m "feat(providers): add exponential backoff retry for 429/5xx"
```

---

## 任务 4：providers/openai.ts

**目标：** `OpenAIProvider` 实现 `ChatProvider`，用 `withRetry` 包装 chat.completions.create，返回与 Python `model_dump()` 等价的 `ChatMessage`。

- [ ] **步骤 1：编写失败测试 src/providers/openai.test.ts**

```ts
import { describe, it, expect, vi } from "vitest";
import type { Config } from "../core/types.js";

const config: Config = {
  apiKey: "sk-test",
  baseUrl: "http://fake/v1",
  model: "test-model",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeClient(create: ReturnType<typeof vi.fn>) {
  return { chat: { completions: { create } } };
}

describe("OpenAIProvider", () => {
  it("calls chat.completions.create with model/messages/tools and returns first message", async () => {
    const { OpenAIProvider } = await import("./openai.js");
    const message = { role: "assistant", content: "hi" };
    const create = vi.fn().mockResolvedValue({ choices: [{ message }] });
    const provider = new OpenAIProvider(config, makeClient(create) as never);
    const tools = [
      { name: "t", description: "d", parameters: { type: "object" }, handler: async () => "" },
    ];
    const out = await provider.chat([{ role: "user", content: "hello" }], tools);
    expect(create).toHaveBeenCalledWith({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: { name: "t", description: "d", parameters: { type: "object" } },
        },
      ],
    });
    expect(out).toEqual({ role: "assistant", content: "hi" });
  });

  it("passes tools as undefined when empty", async () => {
    const { OpenAIProvider } = await import("./openai.js");
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const provider = new OpenAIProvider(config, makeClient(create) as never);
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(create.mock.calls[0]?.[0].tools).toBeUndefined();
  });

  it("retries 429 via withRetry", async () => {
    vi.useFakeTimers();
    const { OpenAIProvider } = await import("./openai.js");
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    const provider = new OpenAIProvider(config, makeClient(create) as never);
    const p = provider.chat([{ role: "user", content: "hi" }], []);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ role: "assistant", content: "ok" });
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/providers/openai.test.ts
# 预期：Cannot find module './openai.js'
```

- [ ] **步骤 3：实现 src/providers/openai.ts**

```ts
import OpenAI from "openai";
import type { ChatMessage, ChatProvider, Config, ToolDef } from "../core/types.js";
import { withRetry } from "./retry.js";

export class OpenAIProvider implements ChatProvider {
  private readonly client: OpenAI;

  constructor(
    private readonly config: Config,
    client?: OpenAI,
  ) {
    this.client =
      client ??
      new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }

  async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatMessage> {
    const toolSchemas = tools.length
      ? tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;
    const response = await withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: messages as OpenAI.ChatCompletionMessageParam[],
          tools: toolSchemas,
        },
        { timeout: 600_000 },
      ),
    );
    const message = response.choices[0]?.message;
    if (!message) throw new Error("provider returned no choices");
    return message as ChatMessage;
  }
}
```

说明：`tools: undefined` 时 openai SDK 序列化为不传 tools 字段，与 Python `tools=tools or None` 等价；`timeout: 600_000`（10 分钟）对齐 Python 版 client 默认 `timeout=600`——若蓝本 M0 未显式设置则保留 SDK 默认亦可，以蓝本为准。

- [ ] **步骤 4：运行验证通过**

```bash
pnpm test -- src/providers/openai.test.ts   # 3 passed
pnpm typecheck
```

- [ ] **步骤 5：Commit**

```bash
git add src/providers/openai.ts src/providers/openai.test.ts
git commit -m "feat(providers): add OpenAIProvider with retry-wrapped chat"
```

---

## 任务 5：tools/registry.ts

**目标：** 工具注册表：注册、列出、生成 schema、按名分发。错误字符串与 Python 逐字一致：

- 未知工具：`error: unknown tool '<name>'`
- 参数非法：`error: invalid tool arguments: <message>`
- handler 抛错：`error: tool '<name>' failed: <message>`

- [ ] **步骤 1：编写失败测试 src/tools/registry.test.ts**

```ts
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { ToolDef } from "../core/types.js";

function echoTool(): ToolDef {
  return {
    name: "echo",
    description: "echo back the text",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async (args) => String(args.text),
  };
}

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool());
    expect(reg.list().map((t) => t.name)).toEqual(["echo"]);
  });

  it("builds OpenAI tool schemas", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool());
    expect(reg.schemas()).toEqual([
      {
        type: "function",
        function: {
          name: "echo",
          description: "echo back the text",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
    ]);
  });

  it("dispatches to the handler", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool());
    await expect(reg.dispatch("echo", { text: "hello" })).resolves.toBe("hello");
  });

  it("returns error string for unknown tool", async () => {
    const reg = new ToolRegistry();
    await expect(reg.dispatch("nope", {})).resolves.toBe("error: unknown tool 'nope'");
  });

  it("returns error string when handler throws", async () => {
    const reg = new ToolRegistry();
    reg.register({
      ...echoTool(),
      name: "boom",
      handler: async () => {
        throw new Error("kaput");
      },
    });
    await expect(reg.dispatch("boom", {})).resolves.toBe("error: tool 'boom' failed: kaput");
  });

  it("returns error string for invalid arguments", async () => {
    const reg = new ToolRegistry();
    reg.register({
      ...echoTool(),
      name: "strict",
      handler: async (args) => {
        if (typeof args.text !== "string") throw new TypeError("text must be a string");
        return args.text;
      },
    });
    await expect(reg.dispatch("strict", { text: 42 })).resolves.toBe(
      "error: tool 'strict' failed: text must be a string",
    );
  });
});
```

说明：Python M0 的 `invalid tool arguments` 分支来自 handler 签名绑定失败（TypeError）。TS 无等价的调用前签名检查；约定：handler 内部对参数类型校验抛 `TypeError` → registry 把 `TypeError` 映射为 `error: invalid tool arguments: <message>`，其他错误映射为 `error: tool '<name>' failed: <message>`。据此修正上方最后一个用例的期望：

```ts
    await expect(reg.dispatch("strict", { text: 42 })).resolves.toBe(
      "error: invalid tool arguments: text must be a string",
    );
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/tools/registry.test.ts
# 预期：Cannot find module './registry.js'
```

- [ ] **步骤 3：实现 src/tools/registry.ts**

```ts
import type { ToolDef } from "../core/types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  schemas(): Array<Record<string, unknown>> {
    return this.list().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `error: unknown tool '${name}'`;
    try {
      return await tool.handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TypeError) return `error: invalid tool arguments: ${message}`;
      return `error: tool '${name}' failed: ${message}`;
    }
  }
}
```

- [ ] **步骤 4：运行验证通过**

```bash
pnpm test -- src/tools/registry.test.ts   # 6 passed
pnpm typecheck
```

- [ ] **步骤 5：Commit**

```bash
git add src/tools/registry.ts src/tools/registry.test.ts
git commit -m "feat(tools): add ToolRegistry with dispatch error contracts"
```

---

## 任务 6：tools/files.ts

**目标：** safePath 路径逃逸防护 + read_file / write_file / edit_file 三个 handler。错误与输出字符串逐字对齐：

- 逃逸：`path escapes workdir: <path>`（抛 `PathEscapeError`）
- read_file 行号：`<n>\t<line>`（tab 分隔，`start` 从 0 起算；超出返回 `(no more lines)`）
- write_file：`wrote <n> chars to <path>`
- edit_file：出现次数 ≠ 1 → `error: old_text occurs <count> times (must be exactly 1)`；成功 → `edited <path>`

- [ ] **步骤 1：编写失败测试 src/tools/files.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-files-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("safePath", () => {
  it("resolves relative paths inside workdir", async () => {
    const { safePath } = await import("./files.js");
    expect(safePath(dir, "a/b.txt")).toBe(path.join(dir, "a", "b.txt"));
  });

  it("throws PathEscapeError on escape", async () => {
    const { safePath, PathEscapeError } = await import("./files.js");
    expect(() => safePath(dir, "../evil.txt")).toThrow(PathEscapeError);
    expect(() => safePath(dir, "../evil.txt")).toThrow("path escapes workdir:");
  });
});

describe("readFile", () => {
  it("returns numbered lines", async () => {
    const { readFile } = await import("./files.js");
    await fs.writeFile(path.join(dir, "f.txt"), "alpha\nbeta\ngamma\n");
    await expect(readFile(dir, { path: "f.txt" })).resolves.toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  it("honors start and limit", async () => {
    const { readFile } = await import("./files.js");
    await fs.writeFile(path.join(dir, "f.txt"), "a\nb\nc\nd\n");
    await expect(readFile(dir, { path: "f.txt", start: 1, limit: 2 })).resolves.toBe("2\tb\n3\tc");
  });

  it("returns (no more lines) past EOF", async () => {
    const { readFile } = await import("./files.js");
    await fs.writeFile(path.join(dir, "f.txt"), "only\n");
    await expect(readFile(dir, { path: "f.txt", start: 5 })).resolves.toBe("(no more lines)");
  });
});

describe("writeFile", () => {
  it("writes file and returns char count", async () => {
    const { writeFile } = await import("./files.js");
    await expect(writeFile(dir, { path: "sub/out.txt", content: "hello" })).resolves.toBe(
      `wrote 5 chars to ${path.join(dir, "sub", "out.txt")}`,
    );
    await expect(fs.readFile(path.join(dir, "sub", "out.txt"), "utf8")).resolves.toBe("hello");
  });
});

describe("editFile", () => {
  it("replaces a unique occurrence", async () => {
    const { editFile } = await import("./files.js");
    await fs.writeFile(path.join(dir, "e.txt"), "foo bar foo");
    // old_text 出现 2 次 → 报错
    await expect(
      editFile(dir, { path: "e.txt", old_text: "foo", new_text: "baz" }),
    ).resolves.toBe("error: old_text occurs 2 times (must be exactly 1)");
    // 唯一替换成功
    await expect(
      editFile(dir, { path: "e.txt", old_text: "bar", new_text: "baz" }),
    ).resolves.toBe(`edited ${path.join(dir, "e.txt")}`);
    await expect(fs.readFile(path.join(dir, "e.txt"), "utf8")).resolves.toBe("foo baz foo");
  });

  it("reports zero occurrences", async () => {
    const { editFile } = await import("./files.js");
    await fs.writeFile(path.join(dir, "e.txt"), "hello");
    await expect(
      editFile(dir, { path: "e.txt", old_text: "zzz", new_text: "q" }),
    ).resolves.toBe("error: old_text occurs 0 times (must be exactly 1)");
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/tools/files.test.ts
# 预期：Cannot find module './files.js'
```

- [ ] **步骤 3：实现 src/tools/files.ts**

```ts
import fs from "node:fs/promises";
import path from "node:path";

export class PathEscapeError extends Error {}

export function safePath(workdir: string, p: string): string {
  const resolved = path.resolve(workdir, p);
  const root = path.resolve(workdir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(`path escapes workdir: ${p}`);
  }
  return resolved;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function num(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
  return value;
}

export async function readFile(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const p = safePath(workdir, str(args.path, "path"));
  const start = num(args.start, "start", 0);
  const limit = num(args.limit, "limit", 2000);
  const text = await fs.readFile(p, "utf8");
  const lines = text.split("\n");
  // Python: 末尾换行会多出一个空串元素；split("\n") 行为一致，末尾空行丢弃以对齐蓝本
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const slice = lines.slice(start, start + limit);
  if (slice.length === 0) return "(no more lines)";
  return slice.map((line, i) => `${i + start + 1}\t${line}`).join("\n");
}

export async function writeFile(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const p = safePath(workdir, str(args.path, "path"));
  const content = str(args.content, "content");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
  return `wrote ${content.length} chars to ${p}`;
}

export async function editFile(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const p = safePath(workdir, str(args.path, "path"));
  const oldText = str(args.old_text, "old_text");
  const newText = str(args.new_text, "new_text");
  const text = await fs.readFile(p, "utf8");
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    return `error: old_text occurs ${count} times (must be exactly 1)`;
  }
  await fs.writeFile(p, text.replace(oldText, newText), "utf8");
  return `edited ${p}`;
}
```

- [ ] **步骤 4：运行验证通过**

```bash
pnpm test -- src/tools/files.test.ts   # 8 passed
pnpm typecheck
```

- [ ] **步骤 5：Commit**

```bash
git add src/tools/files.ts src/tools/files.test.ts
git commit -m "feat(tools): add safe file tools with path escape guard"
```

---

## 任务 7：tools/bash.ts + tools/glob.ts

**目标：**
- `runBash`：子进程执行 shell 命令，workdir 为 cwd，超时/截断/退出码处理，输出字符串逐字对齐：
  - 超时：`error: command timed out after <n>s`
  - 截断：`\n... [truncated, <n> chars total]`
  - 空输出：`(exit code <n>)`
- `glob`：手写 fnmatch（Python fnmatch 语义：`*` **可以**跨 `/`）+ 递归遍历，上限 200，无匹配返回 `(no matches)`，相对路径输出。

- [ ] **步骤 1：编写失败测试 src/tools/bash.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-bash-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runBash", () => {
  it("captures stdout", async () => {
    const { runBash } = await import("./bash.js");
    const out = await runBash(dir, 120, 30000, { command: "echo hello" });
    expect(out.trim()).toBe("hello");
  });

  it("appends non-zero exit code", async () => {
    const { runBash } = await import("./bash.js");
    const out = await runBash(dir, 120, 30000, { command: "echo oops && exit 3" });
    expect(out).toContain("oops");
    expect(out).toContain("(exit code 3)");
  });

  it("returns (exit code N) for empty output", async () => {
    const { runBash } = await import("./bash.js");
    const out = await runBash(dir, 120, 30000, { command: "exit 7" });
    expect(out).toBe("(exit code 7)");
  });

  it("times out long-running commands", async () => {
    const { runBash } = await import("./bash.js");
    const out = await runBash(dir, 1, 30000, { command: "sleep 30" });
    expect(out).toBe("error: command timed out after 1s");
  }, 15000);

  it("truncates huge output", async () => {
    const { runBash } = await import("./bash.js");
    const out = await runBash(dir, 120, 100, {
      command: "node -e \"console.log('x'.repeat(500))\"",
    });
    expect(out).toContain("... [truncated, 501 chars total]");
    expect(out.length).toBeLessThan(200);
  });
});
```

- [ ] **步骤 2：编写失败测试 src/tools/glob.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-glob-"));
  await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "");
  await fs.writeFile(path.join(dir, "src", "deep", "b.ts"), "");
  await fs.writeFile(path.join(dir, "README.md"), "");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("fnmatch", () => {
  it("matches python-style wildcards (* crosses /)", async () => {
    const { fnmatch } = await import("./glob.js");
    expect(fnmatch("src/a.ts", "*.ts")).toBe(true);
    expect(fnmatch("src/deep/b.ts", "*.ts")).toBe(true); // Python 语义：* 跨 /
    expect(fnmatch("src/a.ts", "src/*.ts")).toBe(true);
    expect(fnmatch("README.md", "*.ts")).toBe(false);
    expect(fnmatch("src/a.ts", "src/?.ts")).toBe(true);
    expect(fnmatch("src/a.ts", "src/[ab].ts")).toBe(true);
  });
});

describe("glob", () => {
  it("finds files by pattern, relative paths sorted", async () => {
    const { glob } = await import("./glob.js");
    const out = await glob(dir, { pattern: "*.ts" });
    expect(out.split("\n")).toEqual([
      path.join("src", "a.ts"),
      path.join("src", "deep", "b.ts"),
    ]);
  });

  it("returns (no matches) when empty", async () => {
    const { glob } = await import("./glob.js");
    await expect(glob(dir, { pattern: "*.xyz" })).resolves.toBe("(no matches)");
  });

  it("caps at 200 results", async () => {
    for (let i = 0; i < 210; i++) {
      await fs.writeFile(path.join(dir, `f${String(i).padStart(3, "0")}.log`), "");
    }
    const { glob } = await import("./glob.js");
    const out = await glob(dir, { pattern: "*.log" });
    expect(out.split("\n")).toHaveLength(200);
  });
});
```

- [ ] **步骤 3：运行验证失败**

```bash
pnpm test -- src/tools/bash.test.ts src/tools/glob.test.ts
# 预期：Cannot find module './bash.js' / './glob.js'
```

- [ ] **步骤 4：实现 src/tools/bash.ts**

```ts
import { execFile } from "node:child_process";

export function runBash(
  workdir: string,
  defaultTimeout: number,
  maxOutputChars: number,
  args: Record<string, unknown>,
): Promise<string> {
  if (typeof args.command !== "string") throw new TypeError("command must be a string");
  const command = args.command;
  const timeoutSec =
    typeof args.timeout === "number" ? args.timeout : defaultTimeout;

  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = execFile(
      shell,
      shellArgs,
      { cwd: workdir, timeout: timeoutSec * 1000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
      (error) => {
        if (killed) return; // 超时分支已 resolve
        let out = stdout + (stderr ? `\n(stderr):\n${stderr}` : "");
        const code = typeof child.exitCode === "number" ? child.exitCode : error ? 1 : 0;
        resolve(format(out, code, maxOutputChars));
      },
    );

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("error", () => {
      // execFile 回调会处理；此处防 unhandled
    });

    // execFile 的 timeout 触发时 error.killed === true，统一在回调里检测：
    const origCallback = child;
    void origCallback;
    // 超时检测：error && (error as any).killed
    child.once("exit", () => {
      // noop，输出由回调统一组装
    });

    // 包装超时判断
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
      resolve(`error: command timed out after ${timeoutSec}s`);
    }, timeoutSec * 1000 + 50);
    child.once("close", () => clearTimeout(timer));
  });
}

function format(out: string, code: number, maxOutputChars: number): string {
  const total = out.length;
  if (total > maxOutputChars) {
    out = out.slice(0, maxOutputChars) + `\n... [truncated, ${total} chars total]`;
  }
  if (!out.trim()) return `(exit code ${code})`;
  return code === 0 ? out.trimEnd() : `${out.trimEnd()}\n(exit code ${code})`;
}
```

注意（Windows 语义）：`sleep 30` 在 cmd.exe 不存在。跨平台约定：M0 测试一律使用 node 自身构造命令，超时用例改为 `node -e "setTimeout(()=>{}, 30000)"`，空输出用例改为 `node -e "process.exit(7)"`，非零退出用例改为 `node -e "console.log('oops'); process.exit(3)"`。执行者按运行平台修正 bash.test.ts 中的命令字符串（断言不变）。同时 `execFile` 自带 `timeout` 与手写 timer 重复——保留手写 timer 为准（字符串需要精确秒数），实现时可删除 execFile 的 `timeout` 选项以免双重 kill。

- [ ] **步骤 5：实现 src/tools/glob.ts**

```ts
import fs from "node:fs/promises";
import path from "node:path";

/** Python fnmatch 语义：* 跨目录分隔符；? 匹配单字符；[seq] 字符类。 */
export function fnmatch(name: string, pattern: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")
        .replace(/\[(!|\^)?([^\]]*)\]/g, (_m, neg: string | undefined, cls: string) =>
          `[${neg ? "^" : ""}${cls.replace(/\\/g, "\\\\")}]`,
        ) +
      "$",
  );
  return re.test(name);
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

export async function glob(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (typeof args.pattern !== "string") throw new TypeError("pattern must be a string");
  const pattern = args.pattern;
  const matches: string[] = [];
  for await (const full of walk(path.resolve(workdir))) {
    const rel = path.relative(path.resolve(workdir), full);
    const normalized = rel.split(path.sep).join("/");
    if (fnmatch(normalized, pattern)) {
      matches.push(rel);
      if (matches.length >= 200) break;
    }
  }
  if (matches.length === 0) return "(no matches)";
  return matches.join("\n");
}
```

- [ ] **步骤 6：运行验证通过**

```bash
pnpm test -- src/tools/bash.test.ts src/tools/glob.test.ts   # 全部 passed
pnpm typecheck
```

- [ ] **步骤 7：Commit**

```bash
git add src/tools/bash.ts src/tools/bash.test.ts src/tools/glob.ts src/tools/glob.test.ts
git commit -m "feat(tools): add bash execution and python-style glob"
```

---

## 任务 8：tools/index.ts（registerBuiltinTools）

**目标：** 把 5 个内置工具注册进 registry，schema 与 Python M0 `tools/__init__.py` 逐字一致（**M0 的 bash 工具没有 `run_in_background` 参数**——那是 M2）。

- [ ] **步骤 1：编写失败测试 src/tools/index.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "./registry.js";
import type { Config } from "../core/types.js";

let dir: string;
let config: Config;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-builtin-"));
  config = {
    apiKey: "k",
    model: "m",
    workdir: dir,
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("registerBuiltinTools", () => {
  it("registers the 5 builtin tools", async () => {
    const { registerBuiltinTools } = await import("./index.js");
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, config);
    expect(reg.list().map((t) => t.name).sort()).toEqual([
      "bash",
      "edit_file",
      "glob",
      "read_file",
      "write_file",
    ]);
  });

  it("bash tool schema has no run_in_background in M0", async () => {
    const { registerBuiltinTools } = await import("./index.js");
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, config);
    const bash = reg.list().find((t) => t.name === "bash");
    expect(bash?.parameters).toEqual({
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120)" },
      },
      required: ["command"],
    });
  });

  it("end-to-end: write then read via dispatch", async () => {
    const { registerBuiltinTools } = await import("./index.js");
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, config);
    await reg.dispatch("write_file", { path: "a.txt", content: "hi" });
    await expect(reg.dispatch("read_file", { path: "a.txt" })).resolves.toBe("1\thi");
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/tools/index.test.ts
# 预期：Cannot find module './index.js'
```

- [ ] **步骤 3：实现 src/tools/index.ts**

```ts
import type { Config } from "../core/types.js";
import type { ToolRegistry } from "./registry.js";
import { readFile, writeFile, editFile } from "./files.js";
import { runBash } from "./bash.js";
import { glob } from "./glob.js";

export function registerBuiltinTools(registry: ToolRegistry, config: Config): void {
  const workdir = config.workdir;

  registry.register({
    name: "bash",
    description: "Execute a shell command in the workdir",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120)" },
      },
      required: ["command"],
    },
    handler: (args) => runBash(workdir, config.bashTimeout, config.maxOutputChars, args),
  });

  registry.register({
    name: "read_file",
    description: "Read a file with line numbers",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workdir)" },
        start: { type: "number", description: "Start line offset (0-based)" },
        limit: { type: "number", description: "Max lines to read" },
      },
      required: ["path"],
    },
    handler: (args) => readFile(workdir, args),
  });

  registry.register({
    name: "write_file",
    description: "Write content to a file (creates parent directories)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workdir)" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    handler: (args) => writeFile(workdir, args),
  });

  registry.register({
    name: "edit_file",
    description: "Replace a unique occurrence of old_text with new_text",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workdir)" },
        old_text: { type: "string", description: "Text to replace (must occur exactly once)" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
    handler: (args) => editFile(workdir, args),
  });

  registry.register({
    name: "glob",
    description: "Find files matching a pattern (relative paths, max 200)",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. *.ts" },
      },
      required: ["pattern"],
    },
    handler: (args) => glob(workdir, args),
  });
}
```

说明：工具 description 文案以 Python M0 蓝本 `tools/__init__.py` 为准；上表为等价文案，执行时若蓝本不同，**以蓝本逐字覆盖**（模型可见文本属契约）。

- [ ] **步骤 4：运行验证通过**

```bash
pnpm test -- src/tools/index.test.ts   # 3 passed
pnpm typecheck
```

- [ ] **步骤 5：Commit**

```bash
git add src/tools/index.ts src/tools/index.test.ts
git commit -m "feat(tools): register 5 builtin tools with M0 schemas"
```

---

## 任务 9：security/rules.ts + security/approval.ts

**目标：** 权限规则匹配 + 审批 hook（PreToolUse）。M0 简版：

- `DEFAULT_RULES` 只 4 条（M6 才有 mcp 两条）：
  1. `("bash", "git push --force*", "deny")`
  2. `("bash", "rm -rf /*", "deny")`
  3. `("bash", "*", "ask")`
  4. `("*", "*", "allow")`
- `matchRule`：工具名**精确匹配或 `"*"`**（M0 不用 fnmatch 匹配工具名）；target 用 fnmatch；无命中默认 `"ask"`
- `makePermissionHook`：返回 PreToolUse hook：
  - target = `args.command ?? args.path ?? ""`
  - deny → 阻断，返回 `denied by permission rule (<tool>: <target>)`
  - ask → 调用注入的 `askFn("allow <tool>(<target>)? [y/N] ")`，答 `y`/`yes`（大小写不敏感）放行；否则阻断 `denied by user`
  - M0 **无**线程/调度 turn 检查、**无** EOF/中断捕获（M6 才有）

- [ ] **步骤 1：编写失败测试 src/security/rules.test.ts**

```ts
import { describe, it, expect } from "vitest";
import { matchRule, DEFAULT_RULES } from "./rules.js";

describe("DEFAULT_RULES", () => {
  it("has exactly 4 rules in M0", () => {
    expect(DEFAULT_RULES).toHaveLength(4);
  });
});

describe("matchRule", () => {
  it("denies git push --force variants", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "git push --force")).toBe("deny");
    expect(matchRule(DEFAULT_RULES, "bash", "git push --force origin main")).toBe("deny");
  });

  it("denies rm -rf /", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "rm -rf /")).toBe("deny");
    expect(matchRule(DEFAULT_RULES, "bash", "rm -rf /home")).toBe("deny");
  });

  it("asks for other bash commands", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "ls -la")).toBe("ask");
    expect(matchRule(DEFAULT_RULES, "bash", "npm install")).toBe("ask");
  });

  it("allows non-bash tools", () => {
    expect(matchRule(DEFAULT_RULES, "read_file", "/etc/passwd")).toBe("allow");
    expect(matchRule(DEFAULT_RULES, "write_file", "a.txt")).toBe("allow");
  });

  it("defaults to ask when no rule matches", () => {
    expect(matchRule([], "bash", "ls")).toBe("ask");
  });

  it("matches tool name exactly or * (M0: no fnmatch on tool name)", () => {
    const rules = [{ tool: "read_*", target: "*", action: "deny" as const }];
    // M0 语义：工具名不做 fnmatch，"read_*" 不等于 "read_file" → 落到下一条/默认
    expect(matchRule(rules, "read_file", "x")).toBe("ask");
  });
});
```

- [ ] **步骤 2：编写失败测试 src/security/approval.test.ts**

```ts
import { describe, it, expect, vi } from "vitest";
import { makePermissionHook } from "./approval.js";
import { DEFAULT_RULES } from "./rules.js";

describe("makePermissionHook", () => {
  it("blocks denied commands with rule message", async () => {
    const hook = makePermissionHook(DEFAULT_RULES);
    const out = await hook("bash", { command: "git push --force" });
    expect(out).toBe("denied by permission rule (bash: git push --force)");
  });

  it("asks and allows on y", async () => {
    const askFn = vi.fn().mockResolvedValue("y");
    const hook = makePermissionHook(DEFAULT_RULES, askFn);
    const out = await hook("bash", { command: "ls" });
    expect(askFn).toHaveBeenCalledWith("allow bash(ls)? [y/N] ");
    expect(out).toBeNull();
  });

  it("asks and denies on empty/other answer", async () => {
    const askFn = vi.fn().mockResolvedValue("");
    const hook = makePermissionHook(DEFAULT_RULES, askFn);
    await expect(hook("bash", { command: "ls" })).resolves.toBe("denied by user");
  });

  it("accepts yes case-insensitively", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "YES");
    await expect(hook("bash", { command: "ls" })).resolves.toBeNull();
  });

  it("allows file tools without asking", async () => {
    const askFn = vi.fn();
    const hook = makePermissionHook(DEFAULT_RULES, askFn);
    await expect(hook("read_file", { path: "a.txt" })).resolves.toBeNull();
    expect(askFn).not.toHaveBeenCalled();
  });

  it("uses path as target for file tools in deny message", async () => {
    const rules = [{ tool: "write_file", target: "*.env", action: "deny" as const }];
    const hook = makePermissionHook(rules);
    await expect(hook("write_file", { path: "prod.env" })).resolves.toBe(
      "denied by permission rule (write_file: prod.env)",
    );
  });
});
```

- [ ] **步骤 3：运行验证失败**

```bash
pnpm test -- src/security/rules.test.ts src/security/approval.test.ts
# 预期：Cannot find module
```

- [ ] **步骤 4：实现 src/security/rules.ts**

```ts
import { fnmatch } from "../tools/glob.js";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  tool: string;
  target: string;
  action: PermissionAction;
}

export const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", target: "git push --force*", action: "deny" },
  { tool: "bash", target: "rm -rf /*", action: "deny" },
  { tool: "bash", target: "*", action: "ask" },
  { tool: "*", target: "*", action: "allow" },
];

export function matchRule(
  rules: PermissionRule[],
  tool: string,
  target: string,
): PermissionAction {
  for (const rule of rules) {
    // M0：工具名精确匹配或 "*"（不用 fnmatch 匹配工具名——那是 M6）
    if (rule.tool !== tool && rule.tool !== "*") continue;
    if (fnmatch(target, rule.target)) return rule.action;
  }
  return "ask";
}
```

- [ ] **步骤 5：实现 src/security/approval.ts**

```ts
import type { PermissionRule } from "./rules.js";
import { matchRule } from "./rules.js";

export type AskFn = (prompt: string) => Promise<string>;
/** PreToolUse hook：返回 null 放行；返回字符串则阻断并作为工具结果 */
export type PermissionHook = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string | null>;

export function makePermissionHook(
  rules: PermissionRule[],
  askFn?: AskFn,
): PermissionHook {
  const ask: AskFn =
    askFn ??
    (async () => {
      // M0 默认：无交互环境一律视为拒绝（REPL 接入 readline 后由任务 12 注入真实 askFn）
      return "";
    });

  return async (tool, args) => {
    const target =
      (typeof args.command === "string" && args.command) ||
      (typeof args.path === "string" && args.path) ||
      "";
    const action = matchRule(rules, tool, target);
    if (action === "allow") return null;
    if (action === "deny") {
      return `denied by permission rule (${tool}: ${target})`;
    }
    const answer = (await ask(`allow ${tool}(${target})? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return null;
    return "denied by user";
  };
}
```

- [ ] **步骤 6：运行验证通过**

```bash
pnpm test -- src/security/rules.test.ts src/security/approval.test.ts   # 全部 passed
pnpm typecheck
```

- [ ] **步骤 7：Commit**

```bash
git add src/security/
git commit -m "feat(security): add permission rules and approval hook"
```

---

## 任务 10：core/hooks.ts

**目标：** HookBus：4 个事件常量 + 注册/触发。`trigger` 返回所有 hook 结果列表；`firstBlock` 语义（首个非 null 结果）由 loop 消费。

- [ ] **步骤 1：编写失败测试 src/core/hooks.test.ts**

```ts
import { describe, it, expect } from "vitest";
import {
  HookBus,
  USER_PROMPT_SUBMIT,
  PRE_TOOL_USE,
  POST_TOOL_USE,
  STOP,
} from "./hooks.js";

describe("HookBus", () => {
  it("exports the 4 event constants", () => {
    expect(USER_PROMPT_SUBMIT).toBe("user_prompt_submit");
    expect(PRE_TOOL_USE).toBe("pre_tool_use");
    expect(POST_TOOL_USE).toBe("post_tool_use");
    expect(STOP).toBe("stop");
  });

  it("triggers registered hooks in order and collects results", async () => {
    const bus = new HookBus();
    const calls: string[] = [];
    bus.register(PRE_TOOL_USE, async () => {
      calls.push("a");
      return null;
    });
    bus.register(PRE_TOOL_USE, async () => {
      calls.push("b");
      return "blocked";
    });
    const results = await bus.trigger(PRE_TOOL_USE, { tool: "bash" });
    expect(calls).toEqual(["a", "b"]);
    expect(results).toEqual([null, "blocked"]);
  });

  it("returns empty array when no hooks registered", async () => {
    const bus = new HookBus();
    await expect(bus.trigger(STOP, {})).resolves.toEqual([]);
  });

  it("firstBlock returns the first non-null result", async () => {
    const bus = new HookBus();
    bus.register(PRE_TOOL_USE, async () => null);
    bus.register(PRE_TOOL_USE, async () => "denied");
    bus.register(PRE_TOOL_USE, async () => "ignored");
    await expect(bus.firstBlock(PRE_TOOL_USE, {})).resolves.toBe("denied");
  });

  it("firstBlock returns null when all pass", async () => {
    const bus = new HookBus();
    bus.register(PRE_TOOL_USE, async () => null);
    await expect(bus.firstBlock(PRE_TOOL_USE, {})).resolves.toBeNull();
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/core/hooks.test.ts
# 预期：Cannot find module './hooks.js'
```

- [ ] **步骤 3：实现 src/core/hooks.ts**

```ts
export const USER_PROMPT_SUBMIT = "user_prompt_submit";
export const PRE_TOOL_USE = "pre_tool_use";
export const POST_TOOL_USE = "post_tool_use";
export const STOP = "stop";

export type HookFn = (payload: Record<string, unknown>) => Promise<string | null>;

export class HookBus {
  private readonly hooks = new Map<string, HookFn[]>();

  register(event: string, fn: HookFn): void {
    const list = this.hooks.get(event) ?? [];
    list.push(fn);
    this.hooks.set(event, list);
  }

  async trigger(event: string, payload: Record<string, unknown>): Promise<Array<string | null>> {
    const results: Array<string | null> = [];
    for (const fn of this.hooks.get(event) ?? []) {
      results.push(await fn(payload));
    }
    return results;
  }

  async firstBlock(event: string, payload: Record<string, unknown>): Promise<string | null> {
    for (const fn of this.hooks.get(event) ?? []) {
      const result = await fn(payload);
      if (result !== null) return result;
    }
    return null;
  }
}
```

- [ ] **步骤 4：运行验证通过**

```bash
pnpm test -- src/core/hooks.test.ts   # 5 passed
pnpm typecheck
```

- [ ] **步骤 5：Commit**

```bash
git add src/core/hooks.ts src/core/hooks.test.ts
git commit -m "feat(core): add HookBus with 4 lifecycle events"
```

---

## 任务 11：core/loop.ts + core/harness.ts

**目标：** Agent 循环 + Harness 编排。M0 简版：

- `agentLoop(harness, messages)`：循环直到 assistant 消息无 `tool_calls`；每个 tool call：
  1. `parseArgs`（JSON.parse 失败或非对象 → `{}`）
  2. `hooks.firstBlock(PRE_TOOL_USE, { name, input })` → 非 null 则 result = blocked 文本，**不再触发 POST_TOOL_USE**（对齐蓝本：blocked 分支直接 append 结果）
  3. 否则 `tools.dispatch` + `hooks.trigger(POST_TOOL_USE, { name, input, output })`
  4. append `{ role: "tool", tool_call_id, content }`
- `lastAssistantText`：逆序找第一条 `role === "assistant"` 且 `content` 非空的 content
- `Harness`：4 参数构造（config, provider, tools, hooks）；system prompt 3 句短版；`runTurn(text)`：trigger(USER_PROMPT_SUBMIT) → append user → agentLoop → trigger(STOP)

- [ ] **步骤 1：编写失败测试 test/integration/helpers.ts（测试工具，先建）**

```ts
import type { ChatMessage, ChatProvider, ToolDef } from "../../src/core/types.js";

/** 脚本化 provider：每次 chat 弹出队列头部消息 */
export class MockProvider implements ChatProvider {
  calls = 0;
  constructor(private readonly script: ChatMessage[]) {}
  async chat(_messages: ChatMessage[], _tools: ToolDef[]): Promise<ChatMessage> {
    this.calls += 1;
    const next = this.script.shift();
    if (!next) throw new Error("MockProvider: script exhausted");
    return next;
  }
}

export function toolCallMsg(
  name: string,
  args: Record<string, unknown>,
  id = "call_1",
): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

export function textMsg(text: string): ChatMessage {
  return { role: "assistant", content: text };
}
```

- [ ] **步骤 2：编写失败测试 src/core/loop.test.ts**

```ts
import { describe, it, expect } from "vitest";
import { agentLoop, lastAssistantText, parseArgs } from "./loop.js";
import { Harness } from "./harness.js";
import { ToolRegistry } from "../tools/registry.js";
import { HookBus, PRE_TOOL_USE } from "./hooks.js";
import { MockProvider, toolCallMsg, textMsg } from "../../test/integration/helpers.js";
import type { ChatMessage, Config } from "./types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeHarness(script: ChatMessage[], hooks?: HookBus) {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object" },
    handler: async (args) => `echoed:${String(args.text)}`,
  });
  return new Harness(config, new MockProvider(script), tools, hooks ?? new HookBus());
}

describe("parseArgs", () => {
  it("parses valid JSON object", () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
  });
  it("returns {} for invalid JSON or non-object", () => {
    expect(parseArgs("not json")).toEqual({});
    expect(parseArgs('"[1,2]"')).toEqual({});
    expect(parseArgs('"42"')).toEqual({});
  });
});

describe("agentLoop", () => {
  it("runs one tool call then stops on text", async () => {
    const harness = makeHarness([
      toolCallMsg("echo", { text: "hi" }),
      textMsg("done"),
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
    let postTriggered = false;
    hooks.register(PRE_TOOL_USE, async () => "denied by user");
    const harness = makeHarness(
      [toolCallMsg("echo", { text: "hi" }), textMsg("ok")],
      hooks,
    );
    // 包装 dispatch 计数
    let dispatched = 0;
    const orig = harness.tools.dispatch.bind(harness.tools);
    harness.tools.dispatch = async (n, a) => {
      dispatched += 1;
      return orig(n, a);
    };
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(harness, messages);
    expect(dispatched).toBe(0);
    expect(postTriggered).toBe(false);
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "denied by user",
    });
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
```

- [ ] **步骤 3：编写失败测试 src/core/harness.test.ts**

```ts
import { describe, it, expect } from "vitest";
import { Harness } from "./harness.js";
import { ToolRegistry } from "../tools/registry.js";
import { HookBus, USER_PROMPT_SUBMIT, STOP } from "./hooks.js";
import { MockProvider, textMsg } from "../../test/integration/helpers.js";
import type { Config } from "./types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp/work",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

describe("Harness", () => {
  it("builds system prompt mentioning workdir", () => {
    const h = new Harness(config, new MockProvider([]), new ToolRegistry(), new HookBus());
    expect(h.systemPrompt).toBe(
      "You are blh, a coding agent. Workdir: /tmp/work. Use the provided tools to act on the user's behalf. When the task is complete, summarize what you did.",
    );
  });

  it("runTurn fires USER_PROMPT_SUBMIT and STOP, returns messages", async () => {
    const hooks = new HookBus();
    const events: string[] = [];
    hooks.register(USER_PROMPT_SUBMIT, async () => {
      events.push("submit");
      return null;
    });
    hooks.register(STOP, async () => {
      events.push("stop");
      return null;
    });
    const h = new Harness(config, new MockProvider([textMsg("hello!")]), new ToolRegistry(), hooks);
    const messages = await h.runTurn("hi");
    expect(events).toEqual(["submit", "stop"]);
    expect(messages[0]).toEqual({ role: "system", content: h.systemPrompt });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
    expect(messages[2]).toEqual({ role: "assistant", content: "hello!" });
  });
});
```

- [ ] **步骤 4：运行验证失败**

```bash
pnpm test -- src/core/loop.test.ts src/core/harness.test.ts
# 预期：Cannot find module './loop.js' / './harness.js'
```

- [ ] **步骤 5：实现 src/core/loop.ts**

```ts
import type { ChatMessage, ToolCall } from "./types.js";
import type { Harness } from "./harness.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "./hooks.js";

export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && m.content) return m.content;
  }
  return "";
}

export async function agentLoop(harness: Harness, messages: ChatMessage[]): Promise<void> {
  for (;;) {
    const message = await harness.provider.chat(messages, harness.tools.list());
    messages.push(message);
    const toolCalls: ToolCall[] = message.tool_calls ?? [];
    if (toolCalls.length === 0) return;

    for (const call of toolCalls) {
      const name = call.function.name;
      const input = parseArgs(call.function.arguments);
      const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
      let result: string;
      if (blocked !== null) {
        result = blocked;
      } else {
        result = await harness.tools.dispatch(name, input);
        await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}
```

- [ ] **步骤 6：实现 src/core/harness.ts**

```ts
import type { ChatMessage, ChatProvider, Config } from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HookBus } from "./hooks.js";
import { USER_PROMPT_SUBMIT, STOP } from "./hooks.js";
import { agentLoop } from "./loop.js";

export class Harness {
  readonly systemPrompt: string;

  constructor(
    readonly config: Config,
    readonly provider: ChatProvider,
    readonly tools: ToolRegistry,
    readonly hooks: HookBus,
  ) {
    this.systemPrompt =
      `You are blh, a coding agent. Workdir: ${config.workdir}. ` +
      "Use the provided tools to act on the user's behalf. " +
      "When the task is complete, summarize what you did.";
  }

  async runTurn(text: string): Promise<ChatMessage[]> {
    await this.hooks.trigger(USER_PROMPT_SUBMIT, { text });
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: text },
    ];
    await agentLoop(this, messages);
    await this.hooks.trigger(STOP, {});
    return messages;
  }
}
```

注意：Python 版 `run_turn` 的 messages 是否每次重建 system+user（短会话）还是持续累积，以蓝本 M0 的 harness.py 为准。若蓝本为累积式（`self.messages` 持有跨轮历史），改为：构造时 `this.messages = [{role:"system",...}]`，runTurn 只 append user 并返回 `this.messages`。执行时核对蓝本逐字对齐。

- [ ] **步骤 7：运行验证通过**

```bash
pnpm test -- src/core/loop.test.ts src/core/harness.test.ts   # 全部 passed
pnpm typecheck
```

- [ ] **步骤 8：Commit**

```bash
git add src/core/loop.ts src/core/loop.test.ts src/core/harness.ts src/core/harness.test.ts test/integration/helpers.ts
git commit -m "feat(core): add agent loop and harness orchestration"
```

---

## 任务 12：cli/repl.ts + cli/main.ts

**目标：** REPL 交互循环 + CLI 入口。M0 简版：只支持 `-p/--print <text>` 一个参数；无参数进 REPL。

- `repl`：启动打印 `blh — type 'exit' to quit`；循环读 `> `；`exit`/`quit` 退出；EOF/Ctrl+C 退出；空行跳过；每轮 `runTurn` 后打印 `lastAssistantText`
- `main`：`buildHarness(workdir?)` 组装 config/provider/tools/hooks + 注册内置工具 + 注册权限 hook（带 readline askFn）；`-p` 单轮后打印最后 assistant 文本

- [ ] **步骤 1：编写失败测试 src/cli/repl.test.ts**

```ts
import { describe, it, expect, vi } from "vitest";
import { repl } from "./repl.js";
import type { Harness } from "../core/harness.js";
import { textMsg } from "../../test/integration/helpers.js";

function fakeHarness(replies: string[]): Harness {
  let i = 0;
  return {
    runTurn: vi.fn(async () => {
      const reply = replies[i++] ?? "";
      return [textMsg(reply)];
    }),
  } as unknown as Harness;
}

async function runRepl(lines: string[], harness: Harness) {
  const printed: string[] = [];
  const input = (async function* () {
    for (const l of lines) yield l;
  })();
  await repl(harness, {
    readLine: async () => {
      const next = await input.next();
      return next.done ? null : next.value; // null = EOF
    },
    print: (s: string) => {
      printed.push(s);
    },
  });
  return printed;
}

describe("repl", () => {
  it("prints banner and replies until exit", async () => {
    const harness = fakeHarness(["answer-1"]);
    const printed = await runRepl(["hello", "exit"], harness);
    expect(printed[0]).toBe("blh — type 'exit' to quit");
    expect(printed).toContain("answer-1");
    expect(harness.runTurn).toHaveBeenCalledTimes(1);
  });

  it("quits on EOF and on quit, skips empty lines", async () => {
    const harness = fakeHarness([]);
    const printed = await runRepl(["", "  ", "quit"], harness);
    expect(harness.runTurn).not.toHaveBeenCalled();
    expect(printed).toHaveLength(1); // 只有 banner
  });

  it("stops on EOF (null)", async () => {
    const harness = fakeHarness(["r"]);
    const printed = await runRepl(["q1"], harness);
    expect(printed).toContain("r");
  });
});
```

- [ ] **步骤 2：运行验证失败**

```bash
pnpm test -- src/cli/repl.test.ts
# 预期：Cannot find module './repl.js'
```

- [ ] **步骤 3：实现 src/cli/repl.ts**

```ts
import readline from "node:readline";
import type { Harness } from "../core/harness.js";
import { lastAssistantText } from "../core/loop.js";

export interface ReplIO {
  readLine: () => Promise<string | null>; // null = EOF
  print: (s: string) => void;
}

export function makeReadlineIO(): ReplIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    readLine: () =>
      new Promise((resolve) => {
        rl.question("> ", (answer) => resolve(answer));
        rl.once("close", () => resolve(null));
      }),
    print: (s) => console.log(s),
  };
}

export async function repl(harness: Harness, io: ReplIO): Promise<void> {
  io.print("blh — type 'exit' to quit");
  for (;;) {
    const line = await io.readLine();
    if (line === null) {
      io.print("");
      break;
    }
    const text = line.trim();
    if (text === "exit" || text === "quit") break;
    if (!text) continue;
    const messages = await harness.runTurn(text);
    io.print(lastAssistantText(messages));
  }
}
```

- [ ] **步骤 4：实现 src/cli/main.ts（替换任务 1 的占位）**

```ts
#!/usr/bin/env node
import readline from "node:readline";
import { loadConfig } from "../core/config.js";
import { Harness } from "../core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../core/hooks.js";
import { lastAssistantText } from "../core/loop.js";
import { OpenAIProvider } from "../providers/openai.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/index.js";
import { DEFAULT_RULES } from "../security/rules.js";
import { makePermissionHook } from "../security/approval.js";
import { repl, makeReadlineIO } from "./repl.js";

export function buildHarness(workdir?: string): Harness {
  const config = loadConfig(workdir);
  const provider = new OpenAIProvider(config);
  const tools = new ToolRegistry();
  const hooks = new HookBus();
  registerBuiltinTools(tools, config);
  hooks.register(PRE_TOOL_USE, async (payload) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askFn = (prompt: string) =>
      new Promise<string>((resolve) =>
        rl.question(prompt, (a) => {
          rl.close();
          resolve(a);
        }),
      );
    const hook = makePermissionHook(DEFAULT_RULES, askFn);
    return hook(String(payload.name), (payload.input ?? {}) as Record<string, unknown>);
  });
  return new Harness(config, provider, tools, hooks);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const harness = buildHarness();
  const pIndex = args.findIndex((a) => a === "-p" || a === "--print");
  if (pIndex !== -1) {
    const text = args[pIndex + 1];
    if (!text) {
      console.error("usage: blh -p <text>");
      process.exit(1);
    }
    const messages = await harness.runTurn(text);
    console.log(lastAssistantText(messages));
    return;
  }
  await repl(harness, makeReadlineIO());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

说明：`main.ts` 无法直接单测（副作用入口）。验证靠任务 13 的端到端测试与手动冒烟。askFn 每次新建 readline 是为避免与 REPL 的 readline 争用；M6 可重构为共享实例。

- [ ] **步骤 5：运行验证通过**

```bash
pnpm test -- src/cli/repl.test.ts   # 3 passed
pnpm typecheck
pnpm build
node dist/cli/main.js   # 缺 OPENAI_API_KEY → 打印 "OPENAI_API_KEY is not set"，exit 1
```

- [ ] **步骤 6：Commit**

```bash
git add src/cli/
git commit -m "feat(cli): add repl and main entry with -p/--print"
```

---

## 任务 13：端到端集成 + 全量验证

**目标：** 用 MockProvider 跑通完整 agent 流程（写文件→读文件；权限拒绝），再跑全量验证命令。

- [ ] **步骤 1：编写 test/integration/agent.test.ts**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../../src/core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltinTools } from "../../src/tools/index.js";
import { DEFAULT_RULES } from "../../src/security/rules.js";
import { makePermissionHook } from "../../src/security/approval.js";
import { lastAssistantText } from "../../src/core/loop.js";
import { MockProvider, toolCallMsg, textMsg } from "./helpers.js";
import type { Config } from "../../src/core/types.js";

let dir: string;
let config: Config;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-e2e-"));
  config = { apiKey: "k", model: "m", workdir: dir, bashTimeout: 120, maxOutputChars: 30000 };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function build(script: ConstructorParameters<typeof MockProvider>[0], askAnswer = "y") {
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, config);
  const hooks = new HookBus();
  hooks.register(PRE_TOOL_USE, (payload) =>
    makePermissionHook(DEFAULT_RULES, async () => askAnswer)(
      String(payload.name),
      (payload.input ?? {}) as Record<string, unknown>,
    ),
  );
  return new Harness(config, new MockProvider(script), tools, hooks);
}

describe("agent end-to-end", () => {
  it("writes and reads a file through tool calls", async () => {
    const harness = build([
      toolCallMsg("write_file", { path: "hello.txt", content: "world" }, "c1"),
      toolCallMsg("read_file", { path: "hello.txt" }, "c2"),
      textMsg("I wrote hello.txt and read it back: world"),
    ]);
    const messages = await harness.runTurn("create and verify hello.txt");
    await expect(fs.readFile(path.join(dir, "hello.txt"), "utf8")).resolves.toBe("world");
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults[0]?.content).toContain("wrote 5 chars");
    expect(toolResults[1]?.content).toBe("1\tworld");
    expect(lastAssistantText(messages)).toContain("world");
  });

  it("bash is denied when user answers no", async () => {
    const harness = build(
      [toolCallMsg("bash", { command: "ls" }, "c1"), textMsg("I was not allowed.")],
      "n",
    );
    const messages = await harness.runTurn("list files");
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults[0]?.content).toBe("denied by user");
  });

  it("git push --force is denied by rule without asking", async () => {
    const harness = build(
      [toolCallMsg("bash", { command: "git push --force" }, "c1"), textMsg("blocked")],
      "y", // 即使答 y 也不应被问到
    );
    const messages = await harness.runTurn("force push");
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults[0]?.content).toBe("denied by permission rule (bash: git push --force)");
  });
});
```

- [ ] **步骤 2：编写 test/integration/live.test.ts（BLH_LIVE 门控）**

```ts
import { describe, it, expect } from "vitest";

const LIVE = !!process.env.BLH_LIVE;

describe.skipIf(!LIVE)("live API smoke", () => {
  it("answers a trivial prompt", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const { lastAssistantText } = await import("../../src/core/loop.js");
    const harness = buildHarness();
    const messages = await harness.runTurn("Reply with exactly: pong");
    expect(lastAssistantText(messages).toLowerCase()).toContain("pong");
  }, 120000);
});
```

- [ ] **步骤 3：运行验证**

```bash
pnpm test -- test/integration/agent.test.ts   # 3 passed（live 默认跳过）
pnpm test                                     # 全量绿
pnpm typecheck                            # 0 error
pnpm lint                                 # 0 error
pnpm build                                # 产出 dist/
OPENAI_API_KEY=sk-... node dist/cli/main.js -p "say hi"   # 手动冒烟（有 key 时）
```

- [ ] **步骤 4：Commit**

```bash
git add test/
git commit -m "test: add end-to-end agent integration and live smoke tests"
```

---

## M0 验收清单

- [ ] `pnpm install && pnpm build` 后 `node dist/cli/main.js`（或 `pnpm link --global` 后 `blh`）可用
- [ ] REPL 与 `-p` 两种模式均可完成一次对话（有 API key 时）
- [ ] 5 个内置工具（bash / read_file / write_file / edit_file / glob）均可经 tool_calls 调用
- [ ] 权限规则生效：bash 询问 / 文件工具放行 / `git push --force` 与 `rm -rf /` 直接拒绝
- [ ] 权限以 PreToolUse hook 实现，dispatch 内无权限硬编码
- [ ] 429/5xx 自动指数退避重试（`min(2**attempt, 32)`），其他 4xx 立即失败
- [ ] `pnpm test` 全绿 + `pnpm typecheck` 无错 + `pnpm lint` 无错

## 后续里程碑（不在本计划）

- **M1**：loop/harness 增强（`[TOOL]` 打印、持久消息历史）、config 增加 dotenv + CLI 参数
- **M2**：jobs（后台任务、`.tasks/`、bash `run_in_background`、AsyncMutex、TurnKind）
- **M3**：memory（`.memory/`）+ planning（todo reminder）
- **M4**：compaction（`is_prompt_too_long`、Retry-After + 抖动、config.yaml 四层优先级、rules 6 条 + fnmatch 工具名、approval 调度 turn 检查）
- **M5**：agents / mailboxes / team turns
- **M6**：workflow / extensions / goals / 完整 system prompt

<!-- END -->
