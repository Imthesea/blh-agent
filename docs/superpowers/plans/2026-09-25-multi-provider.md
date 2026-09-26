# 多 Provider 可插拔 + 配置架构重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 Anthropic / Qwen / Kimi 三家厂商支持并做成可插拔体系，同时把配置从散文件 `.blh.yaml` + `~/.config/blh/` 重构为 `~/.blh/` + `.blh/` 目录、按职责拆成 `config.yaml` + `mcp.yaml` + `settings.json`。

**架构：** 借鉴 pi 的「Provider 描述 + api 协议模块」两层分离。新增 `src/providers/` 下的 `catalog.ts`（Provider 描述 + 注册）、`registry.ts`（工厂 `createProvider`）、`anthropic.ts`（原生 Messages API 适配器），并把现有 `openai.ts` 重命名为 `openai-compat.ts`（`OpenAIProvider` → `OpenAICompatProvider`）。配置层 `src/core/config.ts` 重构为目录查找 + 配置文件拆分 + provider/model 多级解析。

**技术栈：** TypeScript 5.x（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）、NodeNext ESM（相对导入带 `.js` 后缀）、vitest 2.x、`openai` SDK 4.x、新增 `@anthropic-ai/sdk`。

**关键决策（已在规格确认）：**
- `Config.provider` 设为**可选** `provider?: string`：12 处测试替身手写 `Config` 用于测试不相关子系统，强制必填会让它们凭空多一个无意义字段；`createProvider` 内 `config.provider ?? "deepseek"` 兜底，`loadConfig` 作为唯一生产入口始终会填入 provider。
- 全局目录 `~/.blh/`（去掉 `.config` 层级），项目目录 `.blh/`（替换散文件 `.blh.yaml`）。
- MCP 从 `config.yaml` 拆到 `mcp.yaml`，全局/项目按 `name` 合并，项目覆盖同名。
- `settings.json` 只放全局（`~/.blh/settings.json`），记忆上次**显式**指定的 provider/model；自动检测结果不写入。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/providers/errors.ts`（新增） | 抽出 `isPromptTooLong`，兼容 OpenAI + Anthropic 两种报错格式 |
| `src/providers/catalog.ts`（新增） | `ProviderDefinition` 描述 + 4 个内置 provider + `getProviderDefinition`/`listProviders`/`registerProvider`/`findFirstConfiguredProvider` |
| `src/providers/registry.ts`（新增） | `createProvider(config)` 工厂 + `resolveApiKey`（按 `def.apiKeyEnv` 顺序读 env） |
| `src/providers/openai-compat.ts`（重命名自 `openai.ts`） | `OpenAICompatProvider`：DeepSeek/Qwen/Kimi 共用的 OpenAI 兼容适配器 |
| `src/providers/anthropic.ts`（新增） | `AnthropicProvider`：原生 Messages API 适配器 |
| `src/providers/retry.ts`（不变） | 通用 `withRetry`/`isRetryable` |
| `src/core/settings.ts`（新增） | `loadSettings`/`saveSettings`，读写 `~/.blh/settings.json` |
| `src/core/types.ts`（修改） | 新增 `ProviderId`/`ProviderApi`/`ProviderDefinition`，`Config.provider?`，`ChatProvider.chatCompletion?` |
| `src/core/config.ts`（修改） | 目录迁移 + `config.yaml`/`mcp.yaml` 拆分 + provider/model 多级解析 |
| `src/core/loop.ts`（修改） | `isPromptTooLong` 改从 `errors.js` 导入 |
| `src/workflow/runtime.ts`（修改） | `OpenAIWorkflowRunner` 依赖 `OpenAIProvider` → `ChatProvider`，`chatCompletion` 可选守卫 |
| `src/cli/parse-args.ts`（修改，实为 `src/core/parse-args.ts`） | 无改动（`--provider` 在 `main.ts` 的 `parseCliArgs` 里加） |
| `src/cli/main.ts`（修改） | `parseCliArgs` 加 `--provider`；`USAGE` 文案 |
| `src/cli/buildHarness.ts`（修改） | `new OpenAIProvider(config)` → `createProvider(config)` |

---

## 任务 1：抽出 `isPromptTooLong` 到 `errors.ts` 并兼容 Anthropic

**文件：**
- 创建：`src/providers/errors.ts`
- 修改：`src/providers/openai.ts`（删除 `isPromptTooLong` 及 `PROMPT_TOO_LONG_KEYWORDS`）
- 修改：`src/core/loop.ts`（第 5 行 import 改为 `errors.js`）
- 测试：`test/providers/errors.test.ts`（新增）、`test/providers/openai.test.ts`（删除 `isPromptTooLong` 两个 describe）

- [ ] **步骤 1：编写失败的测试**

创建 `test/providers/errors.test.ts`：

```ts
import { describe, it, expect } from "vitest";

const badRequest = (text: string) => Object.assign(new Error(text), { status: 400 });
const err = (status: number, text: string) => Object.assign(new Error(text), { status });

describe("isPromptTooLong", () => {
  it("400 + 关键词判定为上下文超长（OpenAI 兼容）", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(badRequest("prompt_too_long: ..."))).toBe(true);
    expect(isPromptTooLong(badRequest("This model's maximum context length is 65536"))).toBe(true);
    expect(isPromptTooLong(badRequest("too many tokens in prompt"))).toBe(true);
    expect(isPromptTooLong(badRequest("context_length_exceeded"))).toBe(true);
    expect(isPromptTooLong(badRequest("invalid api key"))).toBe(false);
  });

  it("Anthropic 关键词也判定为超长", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(badRequest("prompt is too long"))).toBe(true);
    expect(isPromptTooLong(badRequest("number of tokens exceeds"))).toBe(true);
    expect(isPromptTooLong(badRequest("input length exceeds"))).toBe(true);
  });

  it("413/422 + 关键词也判定为超长", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(err(413, "prompt_too_long"))).toBe(true);
    expect(isPromptTooLong(err(422, "context length exceeded"))).toBe(true);
    expect(isPromptTooLong(err(500, "prompt_too_long"))).toBe(false);
  });

  it("非 Error / 无 status 不判定", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(new Error("prompt_too_long"))).toBe(false);
    expect(isPromptTooLong("prompt_too_long")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/providers/errors.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/providers/errors.js'`

- [ ] **步骤 3：编写最少实现代码**

创建 `src/providers/errors.ts`：

```ts
const PROMPT_TOO_LONG_KEYWORDS = [
  // OpenAI 兼容端常见报错
  "prompt_too_long",
  "too many tokens",
  "context length",
  "context_length_exceeded",
  "maximum context",
  "reduce the length",
  // Anthropic 原生端常见报错
  "prompt is too long",
  "number of tokens exceeds",
  "input length exceeds",
] as const;

/** 启发式判定上下文超长：HTTP 400/413/422 + 错误体关键词（各家格式不一） */
export function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error)) return false;
  const status = (error as Error & { status: unknown }).status;
  if (status !== 400 && status !== 413 && status !== 422) return false;
  const text = error.message.toLowerCase();
  return PROMPT_TOO_LONG_KEYWORDS.some((keyword) => text.includes(keyword));
}
```

- [ ] **步骤 4：从 `openai.ts` 删除旧实现并改 `loop.ts` 导入**

`src/providers/openai.ts`：删除文件末尾的 `PROMPT_TOO_LONG_KEYWORDS` 常量和 `isPromptTooLong` 函数（原第 226-242 行）。

`src/core/loop.ts` 第 5 行：
```ts
import { isPromptTooLong } from "../providers/openai.js";
```
改为：
```ts
import { isPromptTooLong } from "../providers/errors.js";
```

`test/providers/openai.test.ts`：删除第 124-148 行的 `describe("isPromptTooLong", ...)` 整个块。

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm test test/providers/errors.test.ts test/providers/openai.test.ts && pnpm typecheck`
预期：PASS，typecheck 无错误

- [ ] **步骤 6：Commit**

```bash
git add src/providers/errors.ts src/providers/openai.ts src/core/loop.ts test/providers/errors.test.ts test/providers/openai.test.ts
git commit -m "refactor(providers): extract isPromptTooLong to errors.ts with anthropic keywords"
```

---

## 任务 2：types.ts 扩展 provider 相关类型

**文件：**
- 修改：`src/core/types.ts`

> 纯类型任务：新增类型 + 可选字段，不改变任何运行行为，用 `pnpm typecheck` 作为验证。

- [ ] **步骤 1：在 `types.ts` 顶部（`ToolCall` 之前）新增 provider 相关类型**

```ts
/** 可插拔 provider 的唯一标识（内置 deepseek/anthropic/qwen/kimi，也允许自定义字符串）。 */
export type ProviderId = string;

/** provider 底层走的 API 协议：openai 兼容 or 原生 anthropic。 */
export type ProviderApi = "openai" | "anthropic";

/** 一个 provider 的静态描述：谁（id/name）+ 怎么（api）+ 默认连接参数。 */
export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  apiKeyEnv: string[];
  defaultModel: string;
}
```

- [ ] **步骤 2：`Config` 接口加可选 `provider`**

在 `Config` 接口（原第 57-66 行）内 `model: string;` 之后加：

```ts
  /** provider id（deepseek/anthropic/qwen/kimi…）；loadConfig 必填，测试替身可省略由 createProvider 兜底 deepseek */
  provider?: string;
```

- [ ] **步骤 3：`ChatProvider` 接口加可选 `chatCompletion`**

在 `ChatProvider` 接口（原第 68-71 行）内、`stream?` 之后加：

```ts
  /** 无 tools 单轮并返回 usage（供 workflow 记账）。可选：未实现时 workflow 不可用。 */
  chatCompletion?(messages: ChatMessage[], maxTokens?: number): Promise<{ message: ChatMessage; usage: ChatUsage }>;
```

注意 `ChatUsage` 定义在 `ChatProvider` 之后（原第 74 行），`ChatMessage` 已在前方定义，`Promise<{ message: ChatMessage; usage: ChatUsage }>` 引用后置类型在 TS 中合法（类型提升）。

- [ ] **步骤 4：运行 typecheck 验证**

运行：`pnpm typecheck`
预期：PASS，无错误（新增均为可选/新类型，不破坏现有代码）

- [ ] **步骤 5：Commit**

```bash
git add src/core/types.ts
git commit -m "feat(types): add ProviderDefinition and optional provider/chatCompletion"
```

---

## 任务 3：catalog.ts（Provider 描述 + 注册 + 自动检测）

**文件：**
- 创建：`src/providers/catalog.ts`
- 测试：`test/providers/catalog.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `test/providers/catalog.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("catalog", () => {
  it("内置 provider 存在且 deepseek 排第一", async () => {
    const { listProviders } = await import("../../src/providers/catalog.js");
    const ids = listProviders();
    expect(ids[0]).toBe("deepseek");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("qwen");
    expect(ids).toContain("kimi");
  });

  it("getProviderDefinition 返回正确描述", async () => {
    const { getProviderDefinition } = await import("../../src/providers/catalog.js");
    expect(getProviderDefinition("deepseek").defaultModel).toBe("deepseek-chat");
    expect(getProviderDefinition("anthropic").api).toBe("anthropic");
    expect(getProviderDefinition("qwen").baseUrl).toContain("dashscope");
    expect(getProviderDefinition("deepseek").apiKeyEnv).toEqual(["DEEPSEEK_API_KEY", "OPENAI_API_KEY"]);
  });

  it("未知 provider 抛错并列出可用项", async () => {
    const { getProviderDefinition } = await import("../../src/providers/catalog.js");
    expect(() => getProviderDefinition("nope")).toThrow(/未知 provider 'nope'/);
  });

  it("registerProvider 新增与覆盖同名", async () => {
    const { registerProvider, getProviderDefinition } = await import("../../src/providers/catalog.js");
    registerProvider({ id: "custom", name: "Custom", api: "openai", baseUrl: "http://x", apiKeyEnv: ["CUSTOM_KEY"], defaultModel: "m" });
    expect(getProviderDefinition("custom").name).toBe("Custom");
    registerProvider({ id: "custom", name: "Custom2", api: "openai", baseUrl: "http://x", apiKeyEnv: ["CUSTOM_KEY"], defaultModel: "m" });
    expect(getProviderDefinition("custom").name).toBe("Custom2");
  });

  it("findFirstConfiguredProvider 返回第一个有 key 的 provider", async () => {
    const { findFirstConfiguredProvider } = await import("../../src/providers/catalog.js");
    expect(findFirstConfiguredProvider()).toBeUndefined();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    expect(findFirstConfiguredProvider()?.id).toBe("anthropic");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds");
    expect(findFirstConfiguredProvider()?.id).toBe("deepseek");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/providers/catalog.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/providers/catalog.js'`

- [ ] **步骤 3：编写实现代码**

创建 `src/providers/catalog.ts`：

```ts
import type { ProviderDefinition, ProviderId } from "../core/types.js";

/** 内置 provider 描述表。catalog 顺序 = 自动检测优先级（deepseek 第一保证老用户升级不变）。 */
const builtin: ProviderDefinition[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
    defaultModel: "deepseek-chat",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "qwen",
    name: "Qwen",
    api: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY"],
    defaultModel: "qwen-max",
  },
  {
    id: "kimi",
    name: "Kimi",
    api: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    defaultModel: "moonshot-v1-8k",
  },
];

const providers: ProviderDefinition[] = [...builtin];

export function getProviderDefinition(id: string): ProviderDefinition {
  const def = providers.find((d) => d.id === id);
  if (!def) {
    throw new Error(`未知 provider '${id}'（可用：${listProviders().join(", ")}）`);
  }
  return def;
}

export function listProviders(): ProviderId[] {
  return providers.map((d) => d.id);
}

export function registerProvider(def: ProviderDefinition): void {
  const idx = providers.findIndex((d) => d.id === def.id);
  if (idx >= 0) providers[idx] = def;
  else providers.push(def);
}

/** 按注册顺序返回第一个「apiKeyEnv 里有非空环境变量」的 provider；都没有则 undefined。 */
export function findFirstConfiguredProvider(): ProviderDefinition | undefined {
  return providers.find((def) =>
    def.apiKeyEnv.some((env) => {
      const value = process.env[env];
      return value !== undefined && value !== "";
    }),
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test test/providers/catalog.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/providers/catalog.ts test/providers/catalog.test.ts
git commit -m "feat(providers): add provider catalog with registration and auto-detect"
```

---

## 任务 4：settings.ts（记忆上次显式选择）

**文件：**
- 创建：`src/core/settings.ts`
- 测试：`test/core/settings.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `test/core/settings.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpUserDir: string;

beforeEach(() => {
  tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "settings-"));
  vi.stubEnv("USERPROFILE", tmpUserDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpUserDir, { recursive: true, force: true });
});

describe("settings", () => {
  it("无文件时返回空对象", async () => {
    const { loadSettings } = await import("../../src/core/settings.js");
    expect(loadSettings()).toEqual({});
  });

  it("保存后可读回", async () => {
    const { loadSettings, saveSettings } = await import("../../src/core/settings.js");
    saveSettings({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(loadSettings()).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("损坏文件容错返回空对象", async () => {
    const { loadSettings } = await import("../../src/core/settings.js");
    mkdirSync(path.join(tmpUserDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpUserDir, ".blh", "settings.json"), "{not json");
    expect(loadSettings()).toEqual({});
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/core/settings.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/core/settings.js'`

- [ ] **步骤 3：编写实现代码**

创建 `src/core/settings.ts`：

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "@blh/logger";

const log = createLogger("core.settings");

export interface Settings {
  provider?: string;
  model?: string;
}

function settingsFile(): string {
  return path.join(os.homedir(), ".blh", "settings.json");
}

/** 读取上次显式选择的 provider/model；文件不存在或损坏时容错返回空对象。 */
export function loadSettings(): Settings {
  try {
    const raw = readFileSync(settingsFile(), "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    const obj = data as Record<string, unknown>;
    const result: Settings = {};
    if (typeof obj.provider === "string") result.provider = obj.provider;
    if (typeof obj.model === "string") result.model = obj.model;
    return result;
  } catch {
    return {};
  }
}

/** 保存显式选择；写入失败仅告警，不中断启动。 */
export function saveSettings(settings: Settings): void {
  try {
    mkdirSync(path.join(os.homedir(), ".blh"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2) + "\n");
  } catch (error) {
    log.warn("保存 settings 失败", { error });
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test test/core/settings.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/core/settings.ts test/core/settings.test.ts
git commit -m "feat(core): add settings memory for last explicit provider/model"
```

---

## 任务 5：openai.ts → openai-compat.ts 重命名（类名 `OpenAICompatProvider`）

**文件：**
- 重命名：`src/providers/openai.ts` → `src/providers/openai-compat.ts`
- 修改：`src/cli/buildHarness.ts`、`src/workflow/runtime.ts`
- 修改：`test/providers/openai.test.ts`

> 纯机械重命名，无新测试；用现有测试 + typecheck 验证不破坏行为。

- [ ] **步骤 1：git mv 重命名文件**

```bash
git mv src/providers/openai.ts src/providers/openai-compat.ts
```

- [ ] **步骤 2：改类名（`openai-compat.ts`）**

把 `export class OpenAIProvider implements ChatProvider {`（原第 68 行）改为：

```ts
export class OpenAICompatProvider implements ChatProvider {
```

（类内没有其它对 `OpenAIProvider` 的自引用，只有这一处声明。）

- [ ] **步骤 3：更新 `buildHarness.ts`**

第 7 行：
```ts
import { OpenAIProvider } from "../providers/openai.js";
```
改为：
```ts
import { OpenAICompatProvider } from "../providers/openai-compat.js";
```

第 85 行：
```ts
const provider = new OpenAIProvider(config);
```
改为：
```ts
const provider = new OpenAICompatProvider(config);
```

- [ ] **步骤 4：更新 `runtime.ts`**

第 4 行：
```ts
import type { OpenAIProvider } from "../providers/openai.js";
```
改为：
```ts
import type { OpenAICompatProvider } from "../providers/openai-compat.js";
```

第 57 行：
```ts
constructor(readonly provider: OpenAIProvider) {}
```
改为：
```ts
constructor(readonly provider: OpenAICompatProvider) {}
```

- [ ] **步骤 5：更新 `test/providers/openai.test.ts`**

全局替换：
- 所有 `import("../../src/providers/openai.js")` → `import("../../src/providers/openai-compat.js")`
- 所有 `OpenAIProvider` → `OpenAICompatProvider`（含 `describe("OpenAIProvider", ...)` → `describe("OpenAICompatProvider", ...)`）

- [ ] **步骤 6：运行测试与 typecheck 验证**

运行：`pnpm test test/providers/openai.test.ts && pnpm typecheck`
预期：PASS，typecheck 无错误

- [ ] **步骤 7：Commit**

```bash
git add src/providers/openai-compat.ts src/cli/buildHarness.ts src/workflow/runtime.ts test/providers/openai.test.ts
git commit -m "refactor(providers): rename OpenAIProvider to OpenAICompatProvider"
```

---

## 任务 6：anthropic.ts（AnthropicProvider 原生 Messages API）

**文件：**
- 创建：`src/providers/anthropic.ts`
- 测试：`test/providers/anthropic.test.ts`
- 修改：`package.json`（新增 `@anthropic-ai/sdk` 依赖）

> 关键事实：`loop.ts` 的 `streamAssistantMessage` 只消费 `text_delta` 与 `done`（忽略 `tool_call_delta`），且 `chat` 调用 `maxTokens` 恒为 `undefined`。因此适配器只产出 `text_delta` + `done`，`max_tokens` 必须给默认值（8192）。

- [ ] **步骤 1：安装依赖**

```bash
pnpm add @anthropic-ai/sdk
```

- [ ] **步骤 2：编写失败的测试**

创建 `test/providers/anthropic.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import type { Config, ToolDefinition } from "../../src/core/types.js";

const config: Config = {
  apiKey: "sk-test",
  model: "claude-test",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeClient(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "e",
  parameters: { type: "object" },
  handler: async () => "",
};

describe("AnthropicProvider", () => {
  it("chat 转换消息（system 顶层 / tool_use / tool_result）并回传 tool_calls", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "echo", input: { a: 1 } },
      ],
      model: "claude-test",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = new AnthropicProvider(config, makeClient(create));
    const result = await provider.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok", tool_calls: [{ id: "t1", type: "function", function: { name: "echo", arguments: '{"a":1}' } }] },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
      [echoTool],
    );
    expect(result.tool_calls?.[0]).toEqual({ id: "t1", type: "function", function: { name: "echo", arguments: '{"a":1}' } });
    const params = create.mock.calls[0][0];
    expect(params.system).toBe("sys");
    expect(params.max_tokens).toBe(8192);
    expect(params.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "echo", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
    ]);
    expect(params.tools).toEqual([{ name: "echo", description: "e", input_schema: { type: "object" } }]);
  });

  it("chatCompletion 返回 usage", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue({
      id: "msg_1", type: "message", role: "assistant",
      content: [{ type: "text", text: "hi" }], model: "x",
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = new AnthropicProvider(config, makeClient(create));
    const { message, usage } = await provider.chatCompletion!([{ role: "user", content: "hi" }]);
    expect(message.content).toBe("hi");
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("stream 拼装 text 并 yield done + usage", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_delta", delta: { stop_reason: null }, usage: { input_tokens: 10, output_tokens: 2 } };
        yield { type: "message_stop" };
      })(),
    );
    const provider = new AnthropicProvider(config, makeClient(create));
    const events: unknown[] = [];
    for await (const e of provider.stream([{ role: "user", content: "hi" }], [])) events.push(e);
    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "done", message: { role: "assistant", content: "Hello" }, usage: { promptTokens: 10, completionTokens: 2 } },
    ]);
  });

  it("stream 拼装 tool_use 的 input_json_delta 为 tool_calls", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } };
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } };
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_stop" };
      })(),
    );
    const provider = new AnthropicProvider(config, makeClient(create));
    const events: unknown[] = [];
    for await (const e of provider.stream([{ role: "user", content: "hi" }], [echoTool])) events.push(e);
    const done = events.find((e) => (e as { type: string }).type === "done") as { message: { tool_calls: unknown[] } };
    expect(done.message.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "echo", arguments: '{"a":1}' } },
    ]);
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm test test/providers/anthropic.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/providers/anthropic.js'`

- [ ] **步骤 4：编写实现代码**

创建 `src/providers/anthropic.ts`：

```ts
import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ChatProvider,
  ChatUsage,
  Config,
  ProviderStreamEvent,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import { parseToolArguments } from "../core/parse-args.js";
import { withRetry } from "./retry.js";
import { createLogger } from "@blh/logger";

const log = createLogger("providers.anthropic");

const DEFAULT_MAX_TOKENS = 8192;

/** 最小化 client 结构：provider 只依赖 messages.create，便于测试注入 */
export interface AnthropicClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
    create(
      params: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<Anthropic.MessageStreamEvent>>;
  };
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const result: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system = (system ? system + "\n\n" : "") + (message.content ?? "");
      continue;
    }
    if (message.role === "user") {
      result.push({ role: "user", content: message.content ?? "" });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
      result.push({ role: "assistant", content: blocks });
      continue;
    }
    // role === "tool"
    result.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content ?? "" }],
    });
  }
  return { ...(system !== undefined ? { system } : {}), messages: result };
}

function fromAnthropicMessage(message: Anthropic.Message): ChatMessage {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export class AnthropicProvider implements ChatProvider {
  private readonly client: AnthropicClient;

  constructor(
    private readonly config: Config,
    client?: AnthropicClient,
  ) {
    this.client =
      client ??
      new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
  }

  private createOptions(signal?: AbortSignal): { signal?: AbortSignal } | undefined {
    return signal !== undefined ? { signal } : undefined;
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): Promise<ChatMessage> {
    log.debug("chat request", { model: this.config.model, messages: messages.length, tools: tools.length });
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const response = await withRetry(() =>
      this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system !== undefined ? { system } : {}),
          messages: anthropicMessages,
          ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
        },
        this.createOptions(signal),
      ),
    );
    log.debug("chat response", { toolCalls: response.content.filter((b) => b.type === "tool_use").length });
    return fromAnthropicMessage(response);
  }

  async chatCompletion(
    messages: ChatMessage[],
    maxTokens?: number,
  ): Promise<{ message: ChatMessage; usage: ChatUsage }> {
    log.debug("chatCompletion request", { model: this.config.model, messages: messages.length });
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const response = await withRetry(() =>
      this.client.messages.create({
        model: this.config.model,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system !== undefined ? { system } : {}),
        messages: anthropicMessages,
      }),
    );
    return {
      message: fromAnthropicMessage(response),
      usage: {
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    maxTokens?: number,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent> {
    log.debug("stream request", { model: this.config.model, messages: messages.length, tools: tools.length });
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const stream = await withRetry(() =>
      this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system !== undefined ? { system } : {}),
          messages: anthropicMessages,
          ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
          stream: true,
        },
        this.createOptions(signal),
      ),
    );

    let text = "";
    const calls = new Map<number, { id: string; name: string; partialJson: string }>();
    let usage: ChatUsage | undefined;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          calls.set(event.index, { id: block.id, name: block.name, partialJson: "" });
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          text += delta.text;
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          const acc = calls.get(event.index);
          if (acc) acc.partialJson += delta.partial_json;
        }
      } else if (event.type === "message_delta" && event.usage) {
        usage = { promptTokens: event.usage.input_tokens, completionTokens: event.usage.output_tokens };
      }
    }

    const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.partialJson || "{}" },
    }));
    const message: ChatMessage = {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    yield { type: "done", message, ...(usage ? { usage } : {}) };
  }
}
```

- [ ] **步骤 5：运行测试与 typecheck 验证**

运行：`pnpm test test/providers/anthropic.test.ts && pnpm typecheck`
预期：PASS，typecheck 无错误（若 `@anthropic-ai/sdk` 类型名有偏差，按 typecheck 报错微调 import 类型名）

- [ ] **步骤 6：Commit**

```bash
git add src/providers/anthropic.ts test/providers/anthropic.test.ts package.json pnpm-lock.yaml
git commit -m "feat(providers): add AnthropicProvider for native Messages API"
```

---

## 任务 7：registry.ts（createProvider 工厂 + resolveApiKey）

**文件：**
- 创建：`src/providers/registry.ts`
- 测试：`test/providers/registry.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `test/providers/registry.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Config } from "../../src/core/types.js";

afterEach(() => vi.unstubAllEnvs());

const noProvider: Config = {
  apiKey: "",
  model: "m",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

describe("createProvider", () => {
  it("deepseek 走 openai 兼容适配器", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds");
    const { createProvider } = await import("../../src/providers/registry.js");
    const { OpenAICompatProvider } = await import("../../src/providers/openai-compat.js");
    const provider = createProvider({ ...noProvider, provider: "deepseek" });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it("anthropic 走原生适配器", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    const { createProvider } = await import("../../src/providers/registry.js");
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const provider = createProvider({ ...noProvider, provider: "anthropic" });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("未设置 provider 时兜底 deepseek", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds");
    const { createProvider } = await import("../../src/providers/registry.js");
    const { OpenAICompatProvider } = await import("../../src/providers/openai-compat.js");
    const provider = createProvider(noProvider);
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it("缺 key 时抛错并列明环境变量", async () => {
    const { createProvider } = await import("../../src/providers/registry.js");
    expect(() => createProvider({ ...noProvider, provider: "kimi" })).toThrow(/MOONSHOT_API_KEY/);
  });

  it("配置文件 api_key 优先于环境变量", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-env");
    const { resolveApiKey } = await import("../../src/providers/registry.js");
    const { getProviderDefinition } = await import("../../src/providers/catalog.js");
    expect(resolveApiKey({ ...noProvider, apiKey: "sk-file" }, getProviderDefinition("deepseek"))).toBe("sk-file");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/providers/registry.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/providers/registry.js'`

- [ ] **步骤 3：编写实现代码**

创建 `src/providers/registry.ts`：

```ts
import type { ChatProvider, Config, ProviderDefinition } from "../core/types.js";
import { getProviderDefinition } from "./catalog.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { AnthropicProvider } from "./anthropic.js";

/** 解析最终 apiKey：配置文件 api_key 优先，否则按 def.apiKeyEnv 顺序读环境变量；都没有则空串。 */
export function resolveApiKey(config: Config, def: ProviderDefinition): string {
  if (config.apiKey) return config.apiKey;
  for (const env of def.apiKeyEnv) {
    const value = process.env[env];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/** 根据 config.provider 创建对应 ChatProvider（未指定时兜底 deepseek）。 */
export function createProvider(config: Config): ChatProvider {
  const def = getProviderDefinition(config.provider ?? "deepseek");
  const apiKey = resolveApiKey(config, def);
  if (!apiKey) {
    const names = def.apiKeyEnv.join(" / ");
    throw new Error(`未设置 ${def.name} 的 API key：请设置环境变量 ${names}，或在配置文件里填 api_key`);
  }
  const resolved: Config = {
    ...config,
    provider: def.id,
    apiKey,
    baseUrl: config.baseUrl ?? def.baseUrl,
  };
  return def.api === "anthropic" ? new AnthropicProvider(resolved) : new OpenAICompatProvider(resolved);
}
```

- [ ] **步骤 4：运行测试与 typecheck 验证**

运行：`pnpm test test/providers/registry.test.ts && pnpm typecheck`
预期：PASS，typecheck 无错误

- [ ] **步骤 5：Commit**

```bash
git add src/providers/registry.ts test/providers/registry.test.ts
git commit -m "feat(providers): add createProvider factory with apiKey resolution"
```

---

## 任务 8：config.ts 重构（目录迁移 + mcp 拆分 + provider 解析）

**文件：**
- 修改：`src/core/config.ts`（重写）
- 修改：`test/core/config.test.ts`（重写）

> 这是重构任务：`loadConfig` 从「`.blh.yaml` + `~/.config/blh/config.yaml` + `mcp_servers` 内联 + 硬编码 `gpt-4o-mini`」迁移到「`.blh/config.yaml` + `~/.blh/config.yaml` + 独立 `mcp.yaml` + provider 多级解析」。

- [ ] **步骤 1：重写 `src/core/config.ts`**

```ts
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config, McpServerConfig, ProviderDefinition } from "./types.js";
import { createLogger } from "@blh/logger";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { getProviderDefinition, findFirstConfiguredProvider } from "../providers/catalog.js";

const log = createLogger("core.config");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function findDotenv(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 收集指定文件名的配置：先全局 ~/.blh/<name>，再项目 .blh/<name>（从 start 向上找第一个）。 */
function findConfigFiles(start: string, filename: string): string[] {
  const files: string[] = [];
  const user = path.join(os.homedir(), ".blh", filename);
  if (isFile(user)) files.push(user);
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".blh", filename);
    if (isFile(candidate)) {
      files.push(candidate);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

function toInt(value: unknown, key: string): number {
  let number: number;
  if (typeof value === "number" && Number.isInteger(value)) {
    number = value;
  } else {
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) {
      throw new ConfigError(`${key} 不是合法的整数: ${JSON.stringify(value)}`);
    }
    number = Number.parseInt(text, 10);
  }
  if (number < 0) {
    throw new ConfigError(`${key} 不能为负数: ${JSON.stringify(value)}`);
  }
  return number;
}

/** 解析 mcp.yaml 顶层数组（逐项转 McpServerConfig）。空值返回空数组。 */
function parseMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`mcp.yaml 必须是数组: ${JSON.stringify(value)}`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ConfigError(`mcp.yaml[${index}] 必须是对象`);
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : "";
    if (!name) throw new ConfigError(`mcp.yaml[${index}] 缺少 name`);
    const server: McpServerConfig = { name };
    if (typeof obj.command === "string") server.command = obj.command;
    if (Array.isArray(obj.args)) server.args = obj.args.map((a) => String(a));
    if (typeof obj.url === "string") server.url = obj.url;
    if (obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)) {
      server.headers = Object.fromEntries(
        Object.entries(obj.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
    return server;
  });
}

/** 加载并合并 mcp.yaml（全局 → 项目，按 name 合并，项目覆盖同名）。 */
function loadMcpServers(start: string): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const filePath of findConfigFiles(start, "mcp.yaml")) {
    const data: unknown = parseYaml(readFileSync(filePath, "utf8"));
    if (data === null || data === undefined) continue;
    for (const server of parseMcpServers(data)) merged.set(server.name, server);
  }
  return [...merged.values()];
}

function providerHasKey(def: ProviderDefinition): boolean {
  return def.apiKeyEnv.some((env) => {
    const value = process.env[env];
    return value !== undefined && value !== "";
  });
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : undefined;
}

/** 加载最终配置：provider/model 多级解析，配置目录 ~/.blh/ + .blh/，MCP 拆到 mcp.yaml。 */
export function loadConfig(workdir?: string, cli?: Record<string, unknown>): Config {
  const dotenv = findDotenv(process.cwd());
  if (dotenv) loadDotenv({ path: dotenv });

  const cliValues = cli ?? {};

  const fileValues: Record<string, unknown> = {};
  for (const filePath of findConfigFiles(process.cwd(), "config.yaml")) {
    const data: unknown = parseYaml(readFileSync(filePath, "utf8"));
    if (data === null || data === undefined) continue;
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new ConfigError(`配置文件 ${filePath} 必须是一个键值对映射`);
    }
    Object.assign(fileValues, data);
  }
  log.debug("配置已加载", { files: findConfigFiles(process.cwd(), "config.yaml") });

  const mcpServers = loadMcpServers(process.cwd());

  // provider 解析：CLI > BLH_PROVIDER > file > settings 记忆(有 key) > 自动检测 > deepseek
  const explicitProvider =
    stringOrUndefined(cliValues.provider) ?? envOrUndefined("BLH_PROVIDER") ?? stringOrUndefined(fileValues.provider);
  const settings = loadSettings();
  let providerId = explicitProvider;
  if (!providerId && settings.provider) {
    try {
      if (providerHasKey(getProviderDefinition(settings.provider))) providerId = settings.provider;
    } catch {
      // 记忆的 provider 已不存在，跳过
    }
  }
  if (!providerId) providerId = findFirstConfiguredProvider()?.id;
  if (!providerId) providerId = "deepseek";
  const def = getProviderDefinition(providerId);

  // model 解析：CLI > OPENAI_MODEL > file > settings 记忆(同 provider 时) > defaultModel
  const explicitModel =
    stringOrUndefined(cliValues.model) ?? envOrUndefined("OPENAI_MODEL") ?? stringOrUndefined(fileValues.model);
  let model = explicitModel;
  if (!model && providerId === settings.provider && settings.model) model = settings.model;
  if (!model) model = def.defaultModel;

  // baseUrl 解析：CLI > OPENAI_BASE_URL > file > def.baseUrl
  const baseUrl =
    stringOrUndefined(cliValues.base_url) ?? envOrUndefined("OPENAI_BASE_URL") ?? stringOrUndefined(fileValues.base_url) ?? def.baseUrl;

  // apiKey 只从 file（环境变量 key 交给 createProvider 按 def.apiKeyEnv 解析）
  const apiKey = stringOrUndefined(fileValues.api_key) ?? "";

  // 记忆上次显式选择（至少一项显式才写；换 provider 且无显式 model 时清除旧 model 记忆）
  if (explicitProvider || explicitModel) {
    const nextSettings: Settings = { ...settings };
    if (explicitProvider) {
      nextSettings.provider = explicitProvider;
      if (!explicitModel) delete nextSettings.model;
    }
    if (explicitModel) nextSettings.model = explicitModel;
    saveSettings(nextSettings);
  }

  const workdirValue = String(workdir ?? process.cwd());
  const bashTimeout = toInt(cliValues.bash_timeout ?? envOrUndefined("BLH_BASH_TIMEOUT") ?? fileValues.bash_timeout ?? 120, "bash_timeout");
  const maxOutputChars = toInt(
    cliValues.max_output_chars ?? envOrUndefined("BLH_MAX_OUTPUT_CHARS") ?? fileValues.max_output_chars ?? 30000,
    "max_output_chars",
  );

  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model,
    provider: providerId,
    workdir: workdirValue,
    bashTimeout,
    maxOutputChars,
    mcpServers,
  };
}
```

> 注：`bash_timeout`/`max_output_chars` 保持原语义（CLI > env > file > 默认），不再走 `get()`（`get` 已删除）。`api_key` 的 env 读取移交给 `createProvider`。

- [ ] **步骤 2：重写 `test/core/config.test.ts`**

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig provider/model", () => {
  let tmpDir: string;
  let tmpUserDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-"));
    tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "config-user-"));
    process.chdir(tmpDir);
    vi.stubEnv("USERPROFILE", tmpUserDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpUserDir, { recursive: true, force: true });
  });

  it("默认 provider 为 deepseek，model 用其 defaultModel", async () => {
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.provider).toBe("deepseek");
    expect(config.model).toBe("deepseek-chat");
    expect(config.baseUrl).toBe("https://api.deepseek.com");
    expect(config.apiKey).toBe("");
    expect(config.mcpServers).toEqual([]);
  });

  it("BLH_PROVIDER 环境变量指定 provider", async () => {
    vi.stubEnv("BLH_PROVIDER", "anthropic");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-5");
  });

  it("配置文件 .blh/config.yaml 覆盖默认", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "config.yaml"), "provider: qwen\nmodel: qwen-plus\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.provider).toBe("qwen");
    expect(config.model).toBe("qwen-plus");
  });

  it("全局 ~/.blh/config.yaml 优先于默认，项目 .blh/config.yaml 再覆盖全局", async () => {
    mkdirSync(path.join(tmpUserDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpUserDir, ".blh", "config.yaml"), "provider: kimi\n");
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "config.yaml"), "provider: qwen\n");
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().provider).toBe("qwen");
  });

  it("cli 覆盖一切", async () => {
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig(undefined, { provider: "anthropic", model: "claude-x" });
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-x");
  });

  it("显式 provider 写入 settings 记忆", async () => {
    const { loadConfig } = await import("../../src/core/config.js");
    const { loadSettings } = await import("../../src/core/settings.js");
    vi.stubEnv("BLH_PROVIDER", "qwen");
    loadConfig();
    expect(loadSettings().provider).toBe("qwen");
  });
});

describe("loadConfig mcp.yaml", () => {
  let tmpDir: string;
  let tmpUserDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-mcp-"));
    tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "config-mcp-user-"));
    process.chdir(tmpDir);
    vi.stubEnv("USERPROFILE", tmpUserDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpUserDir, { recursive: true, force: true });
  });

  it("加载 .blh/mcp.yaml（stdio 与 http）", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".blh", "mcp.yaml"),
      [
        "- name: web-search",
        "  command: npx",
        '  args: ["-y", "open-websearch@latest"]',
        "- name: hotel",
        "  url: https://mcp.example.com/mcp",
        "  headers:",
        "    Authorization: Bearer abc",
        "",
      ].join("\n"),
    );
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().mcpServers).toEqual([
      { name: "web-search", command: "npx", args: ["-y", "open-websearch@latest"] },
      { name: "hotel", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" } },
    ]);
  });

  it("全局与项目 mcp.yaml 按 name 合并，项目覆盖同名", async () => {
    mkdirSync(path.join(tmpUserDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpUserDir, ".blh", "mcp.yaml"), "- name: shared\n  url: https://shared\n");
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "mcp.yaml"), "- name: shared\n  url: https://project-override\n- name: local\n  command: npx\n");
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().mcpServers).toEqual([
      { name: "shared", url: "https://project-override" },
      { name: "local", command: "npx" },
    ]);
  });

  it("mcp.yaml 不是数组时抛 ConfigError", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "mcp.yaml"), "name: not-array\n");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("mcp.yaml 某项缺少 name 时抛 ConfigError", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "mcp.yaml"), "- command: npx\n");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

describe("loadConfig 数值与 api_key", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-num-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("api_key 从配置文件读取（环境变量不再读）", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "config.yaml"), "api_key: sk-file\n");
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().apiKey).toBe("sk-file");
  });

  it("非法整数抛 ConfigError", async () => {
    vi.stubEnv("BLH_BASH_TIMEOUT", "abc");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
```

- [ ] **步骤 3：运行测试与 typecheck 验证**

运行：`pnpm test test/core/config.test.ts && pnpm typecheck`
预期：PASS，typecheck 无错误

- [ ] **步骤 4：Commit**

```bash
git add src/core/config.ts test/core/config.test.ts
git commit -m "refactor(config): migrate dirs to ~/.blh and .blh, split mcp.yaml, add provider resolution"
```

---

## 任务 9：buildHarness.ts 改用 `createProvider(config)`

**文件：**
- 修改：`src/cli/buildHarness.ts`（第 7 行 import、第 84-85 行 provider 创建）

> 纯接线改动，无新测试；用现有 `test/cli/main.test.ts`（buildHarness 装配 + HTTP MCP）与 typecheck 验证不破坏行为。

- [ ] **步骤 1：改 import**

第 7 行：
```ts
import { OpenAICompatProvider } from "../providers/openai-compat.js";
```
改为：
```ts
import { createProvider } from "../providers/registry.js";
```

- [ ] **步骤 2：改 provider 创建 + 注释**

第 84-85 行：
```ts
  // 创建模型提供者：负责真正调用 OpenAI 接口（这是所有「用模型」能力的底层）。
  const provider = new OpenAICompatProvider(config);
```
改为：
```ts
  // 创建模型提供者：按 config.provider 走对应厂商适配器（这是所有「用模型」能力的底层）。
  const provider = createProvider(config);
```

- [ ] **步骤 3：运行测试与 typecheck 验证**

运行：`pnpm test test/cli/main.test.ts && pnpm typecheck`
预期：PASS（buildHarness 测试在 beforeEach 里设了 `OPENAI_API_KEY=k`，deepseek 兜底通过 `apiKeyEnv` 命中它），typecheck 无错误

- [ ] **步骤 4：Commit**

```bash
git add src/cli/buildHarness.ts
git commit -m "refactor(cli): buildHarness uses createProvider factory"
```

---

## 任务 10：runtime.ts 依赖改 `ChatProvider` + `chatCompletion` 守卫

**文件：**
- 修改：`src/workflow/runtime.ts`（第 4 行 import、第 55-57 行类声明、第 66 行调用）
- 修改：`test/workflow/runtime.test.ts`（新增守卫测试）

- [ ] **步骤 1：编写失败的测试**

在 `test/workflow/runtime.test.ts` 顶部加类型导入，并新增 describe。顶部 import 块里 `import { ... } from "../../src/workflow/runtime.js";` 之后加：

```ts
import type { ChatProvider } from "../../src/core/types.js";
```

文件末尾（`describe("ExecutionState", ...)` 之后）追加：

```ts
describe("OpenAIWorkflowRunner", () => {
  it("provider 缺少 chatCompletion 时构造抛错", async () => {
    const { OpenAIWorkflowRunner } = await import("../../src/workflow/runtime.js");
    const provider = {
      chat: async () => ({ role: "assistant" as const, content: null }),
    } as unknown as ChatProvider;
    expect(() => new OpenAIWorkflowRunner(provider)).toThrow(/chatCompletion/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/workflow/runtime.test.ts`
预期：FAIL（当前 `OpenAIWorkflowRunner` 构造不抛错，仍可 new；若类型报错也符合预期——还没改实现）

- [ ] **步骤 3：编写实现代码**

`src/workflow/runtime.ts`：

第 4 行：
```ts
import type { OpenAICompatProvider } from "../providers/openai-compat.js";
```
改为：
```ts
import type { ChatProvider } from "../core/types.js";
```

第 55-57 行：
```ts
/** workflow 子 agent:无 tools 单轮,复用 host 的 OpenAI provider,拿 usage 记账。 */
export class OpenAIWorkflowRunner implements WorkflowRunner {
  constructor(readonly provider: OpenAICompatProvider) {}
```
改为：
```ts
/** workflow 子 agent:无 tools 单轮,复用 host 的 provider,拿 usage 记账。 */
export class OpenAIWorkflowRunner implements WorkflowRunner {
  private readonly chatCompletion: NonNullable<ChatProvider["chatCompletion"]>;

  constructor(readonly provider: ChatProvider) {
    if (!provider.chatCompletion) {
      throw new Error("OpenAIWorkflowRunner 需要支持 chatCompletion 的 provider");
    }
    this.chatCompletion = provider.chatCompletion;
  }
```

第 66 行：
```ts
    const { message, usage } = await this.provider.chatCompletion(
```
改为：
```ts
    const { message, usage } = await this.chatCompletion(
```

（`run` 方法内其余逻辑不变。）

- [ ] **步骤 4：运行测试与 typecheck 验证**

运行：`pnpm test test/workflow/runtime.test.ts && pnpm typecheck`
预期：PASS，typecheck 无错误

- [ ] **步骤 5：Commit**

```bash
git add src/workflow/runtime.ts test/workflow/runtime.test.ts
git commit -m "refactor(workflow): depend on ChatProvider and guard optional chatCompletion"
```

---

## 任务 11：main.ts 加 `--provider` + 更新 `USAGE`

**文件：**
- 修改：`src/cli/main.ts`（`parseCliArgs` options、`cli` 组装、`USAGE`）
- 修改：`test/cli/main.test.ts`（新增 `--provider` 解析测试）

- [ ] **步骤 1：编写失败的测试**

在 `test/cli/main.test.ts` 的 `describe("parseCliArgs", ...)` 内、`parses model and base-url flags` 测试之后加：

```ts
  it("parses --provider flag", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["--provider", "anthropic", "--model", "claude-x"]);
    expect(parsed.cli.provider).toBe("anthropic");
    expect(parsed.cli.model).toBe("claude-x");
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/cli/main.test.ts -t "parses --provider flag"`
预期：FAIL，`parsed.cli.provider` 为 `undefined`

- [ ] **步骤 3：编写实现代码**

`src/cli/main.ts`：

`parseCliArgs` 的 `options`（第 59-71 行）加 `provider`，即 `"base-url"` 那行之后加：
```ts
      provider: { type: "string" },
```

`stringValue` 取值区（第 73-76 行附近）加：
```ts
  const provider = stringValue(values, "provider");
```

`cli` 组装区（第 88-93 行）加：
```ts
  if (provider !== undefined) cli.provider = provider;
```

`USAGE`（第 134-153 行）第一行与选项区更新：第一行 `[--model 模型] [--base-url 基础地址]` 改为 `[--provider 厂商] [--model 模型] [--base-url 基础地址]`；选项区 `-p, --print 提示词` 之前插入：
```
  --provider 厂商         provider id（deepseek/anthropic/qwen/kimi；默认 deepseek）
```

- [ ] **步骤 4：运行测试与 typecheck 验证**

运行：`pnpm test test/cli/main.test.ts && pnpm typecheck`
预期：PASS，typecheck 无错误

- [ ] **步骤 5：Commit**

```bash
git add src/cli/main.ts test/cli/main.test.ts
git commit -m "feat(cli): add --provider flag"
```

---

## 任务 12：配置迁移 + 文档更新

**文件：**
- 创建：`.blh/mcp.yaml`（迁移自 `.blh.yaml`）
- 删除：`.blh.yaml`
- 修改：`test/cli/main.test.ts`（第 169 行 MCP 配置写入路径与格式）
- 修改：`README.md`、`.env.example`

> 硬切换：一次性把现有 `.blh.yaml` 里的 `mcp_servers` 拆到 `.blh/mcp.yaml` 顶层数组；项目根不再留 `.blh.yaml`。

- [ ] **步骤 1：创建 `.blh/mcp.yaml`**

```yaml
# 启动时自动连接的 MCP 服务器列表（顶层数组）。
# 每项二选一：本地 stdio（command + args）或远程 HTTP（url + headers）。

- name: weather
  command: npx
  args: ["-y", "@dangahagan/weather-mcp@latest"]

- name: web-search
  command: npx
  args: ["-y", "open-websearch@latest"]
```

- [ ] **步骤 2：删除旧 `.blh.yaml`**

```bash
git rm .blh.yaml
```

- [ ] **步骤 3：更新 `test/cli/main.test.ts` 第 169 行**

原：
```ts
      writeFileSync(
        path.join(tmpDir, ".blh.yaml"),
        ["mcp_servers:", "  - name: fakehttp", `    url: ${server.url}`, ""].join("\n"),
      );
```
改为：
```ts
      writeFileSync(
        path.join(tmpDir, ".blh", "mcp.yaml"),
        ["- name: fakehttp", `  url: ${server.url}`, ""].join("\n"),
      );
```

（注意：`buildHarness` 会自动创建 `.blh` 目录吗？`loadMcpServers` 用 `findConfigFiles` 检查文件是否存在，`isFile` 用 `statSync`；`writeFileSync` 需要父目录 `.blh` 已存在，故此处需先 `mkdirSync`。）

补一行（`writeFileSync` 之前）：
```ts
      mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
```
同时确认 `main.test.ts` 顶部已 `import { mkdirSync }`（当前第 1 行只 `import { mkdtempSync, rmSync, writeFileSync }`），需补 `mkdirSync`。

- [ ] **步骤 4：更新 `.env.example`**

替换为：

```dotenv
# blh 环境变量示例。复制本文件为 .env 并填入你自己的值。
# 至少给一家厂商配一个 key（否则启动时报错）。

# provider id：deepseek / anthropic / qwen / kimi（默认 deepseek）
BLH_PROVIDER=

# DeepSeek（默认厂商）
DEEPSEEK_API_KEY=
# Anthropic
ANTHROPIC_API_KEY=
# Qwen（阿里云百炼）
DASHSCOPE_API_KEY=
# Kimi（月之暗面）
MOONSHOT_API_KEY=

# 可选：OpenAI 兼容接口的通用 key（DeepSeek 的兜底来源之一）
OPENAI_API_KEY=

# 可选：显式指定模型名（覆盖所选 provider 的默认模型）
OPENAI_MODEL=

# 可选：显式指定 OpenAI 兼容网关基础地址（覆盖 provider 默认）
OPENAI_BASE_URL=

# 可选：bash 命令超时秒数（默认 120）
BLH_BASH_TIMEOUT=

# 可选：工具输出最大捕获字符数（默认 30000）
BLH_MAX_OUTPUT_CHARS=

# 可选：日志级别 debug / info / warn / error（默认 info）
BLH_LOG_LEVEL=
```

- [ ] **步骤 5：更新 `README.md`**

按下面五处改（用精确上下文替换）：

**(a)** 第 52-57 行 dotenv 示例改为：
```dotenv
DEEPSEEK_API_KEY=sk-...
# 或改用其他厂商：ANTHROPIC_API_KEY / DASHSCOPE_API_KEY / MOONSHOT_API_KEY
```

**(b)** 第 157-165 行配置表改为：
```
| 键 | 环境变量 | CLI 参数 | 默认值 |
|---|---|---|---|
| `provider` | `BLH_PROVIDER` | `--provider` | `deepseek`（无显式时自动检测第一个有 key 的厂商） |
| `api_key` | （见厂商 key） | — | 无（缺失则退出） |
| `base_url` | `OPENAI_BASE_URL` | `--base-url` | 厂商默认 |
| `model` | `OPENAI_MODEL` | `--model` | 厂商 defaultModel（deepseek-chat） |
| `workdir` | — | `--workdir` | 当前目录 |
| `bash_timeout` | `BLH_BASH_TIMEOUT` | `--bash-timeout` | `120` |
| `max_output_chars` | `BLH_MAX_OUTPUT_CHARS` | `--max-output-chars` | `30000` |
```

**(c)** 第 169-183 行「配置文件」段改为：
```
- 用户级:`~/.blh/config.yaml`
- 项目级:`.blh/config.yaml`(从当前目录向上查找第一个)

两个文件均存在时,用户级先读、项目级后读,后读覆盖先读。YAML 使用 snake_case 键名:

```yaml
provider: deepseek
api_key: sk-...
base_url: https://api.deepseek.com
model: deepseek-chat
```

MCP 服务器单独写在 `mcp.yaml`(见下节),不放 `config.yaml`。
```

**(d)** 第 191-207 行「MCP 服务器」段改为 `mcp.yaml` 顶层数组格式：
```
`mcp_servers` 拆分到独立的 `.blh/mcp.yaml`(全局 `~/.blh/mcp.yaml`)。顶层是数组,每项二选一:本地 stdio(`command` + `args`)或远程 HTTP(`url` + `headers`),启动时会自动后台连接:

```yaml
# 本地 stdio
- name: weather
  command: npx
  args: ["-y", "@dangahagan/weather-mcp@latest"]

# 远程 HTTP
- name: web-search
  url: https://example.com/mcp
  headers:
    Authorization: "Bearer ..."
```
```

**(e)** 第 188 行 CLI 示例改为：
```powershell
pnpm dev -- --provider deepseek --model deepseek-chat
```

- [ ] **步骤 6：运行全量测试与 typecheck 验证**

运行：`pnpm test && pnpm typecheck && pnpm build`
预期：PASS（含 `test/cli/main.test.ts` 的 HTTP MCP 自动连接测试走新 `.blh/mcp.yaml` 路径），typecheck/build 无错误

- [ ] **步骤 7：Commit**

```bash
git add .blh/mcp.yaml README.md .env.example test/cli/main.test.ts
git commit -m "chore(config): migrate .blh.yaml to .blh/mcp.yaml and update docs"
```

---

## 最终自检

**1. 规格覆盖度：** 对照 `docs/superpowers/specs/2026-09-25-multi-provider-design.md` 逐条核对——

- [ ] 两层分离（Provider 描述 + api 协议模块）：任务 3（catalog）+ 任务 5/6（两个协议适配器）+ 任务 7（registry 工厂）✓
- [ ] 四家厂商：任务 3 catalog 内置 deepseek/anthropic/qwen/kimi ✓
- [ ] 可插拔（registerProvider）：任务 3 ✓
- [ ] 砍掉 auth/cost：设计无 auth/cost 模块 ✓
- [ ] settings.json 记忆：任务 4（settings）+ 任务 8（loadConfig 读写记忆）✓
- [ ] 自动检测第一个有 key 的 provider：任务 3（findFirstConfiguredProvider）+ 任务 8（loadConfig 调用）✓
- [ ] 目录对齐 pi（`~/.blh/` + `.blh/`）：任务 8 ✓
- [ ] 配置拆 `config.yaml` + `mcp.yaml` + `settings.json`：任务 8 + 任务 12 ✓
- [ ] `--provider` CLI + USAGE：任务 11 ✓
- [ ] buildHarness/runtime 接线：任务 9/10 ✓

**2. 占位符扫描：** 搜索 `TODO`、`待定`、`后续实现`、`类似任务 N`、`补充细节`。预期：无。任务 6 的「按 typecheck 报错微调 import 类型名」是合法的验证指引，非占位符。

**3. 类型一致性：**
- [ ] `ProviderDefinition` 字段（`id/name/api/baseUrl/apiKeyEnv/defaultModel`）在 catalog（任务 3）与 config（任务 8 `def.defaultModel`、`def.baseUrl`）、registry（任务 7 `def.apiKeyEnv`/`def.baseUrl`）一致 ✓
- [ ] `ProviderId`/`ProviderApi` 类型在 types.ts（任务 2）定义，catalog 导入使用 ✓
- [ ] `ChatProvider.chatCompletion?`（任务 2）在 runtime（任务 10）以 `NonNullable<...>` 收窄 ✓
- [ ] `Config.provider?` 在 config 输出（任务 8）与 createProvider 兜底（任务 7 `config.provider ?? "deepseek"`）一致 ✓
- [ ] `createProvider` 导入路径 `../providers/registry.js` 在 buildHarness（任务 9）与 registry 定义（任务 7）一致 ✓
- [ ] `findFirstConfiguredProvider`/`getProviderDefinition` 导出名在 catalog（任务 3）与 config（任务 8）一致 ✓
