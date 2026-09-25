# 多 Provider 可插拔 + 配置架构重构

- 日期：2026-09-25
- 状态：待审查

## 1. 背景与目标

当前项目只通过一个 `OpenAIProvider` 调用模型（DeepSeek 因兼容 OpenAI 协议而可用），`buildHarness` 里硬编码 `new OpenAIProvider(config)`，配置层也只认 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。

本次有两类目标：

**A. 多 Provider 可插拔**

新增三家厂商支持并做成可插拔：

- **Anthropic**（原生 Messages API）
- **Qwen**（DashScope 的 OpenAI 兼容端点）
- **Kimi**（Moonshot 的 OpenAI 兼容端点）

借鉴 pi（`re-pi/packages/ai`）的「Provider 描述 + api 协议模块」两层分离思路，但砍掉 auth/cost 目录（用户明确不需要），只保留可插拔的注册表 + 工厂。关键事实：Qwen、Kimi 与 DeepSeek 一样走 OpenAI 兼容协议，**真正需要新写的协议适配器只有 Anthropic 一个**，因此可插拔体系由「2 个协议适配器 + N 个 Provider 描述 + 1 个注册表/工厂」构成。

**B. 配置架构重构（对齐 pi 的目录分层）**

当前配置职责混在一起：全局配置在 `~/.config/blh/config.yaml`，项目配置在散文件 `.blh.yaml`，且 `mcp_servers`（MCP 服务器列表）也塞在同一个 yaml 里。本次重构：

- 全局目录统一为 `~/.blh/`（去掉 `.config` 层级，对齐 pi 的 `~/.pi/`）。
- 项目目录统一为 `.blh/`（对齐 pi 的 `.pi/`，替换散文件 `.blh.yaml`）。
- 配置按职责拆成三个文件：`config.yaml`（模型/运行时）+ `mcp.yaml`（MCP 服务器）+ `settings.json`（上次选择记忆）。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| Provider 选择方式 | 显式 `--provider` / `BLH_PROVIDER` / `.blh/config.yaml` 的 `provider`；缺省时按「settings 记忆 → 第一个有 key 的 provider → deepseek」回退 |
| 记住上次选择 | 是：`settings.json` 记忆上次显式指定的 provider/model（自动检测结果不写入，避免记忆污染） |
| 自动检测默认 | 是：按 catalog 顺序找第一个 `apiKeyEnv` 有非空环境变量的 provider |
| 默认 provider 兜底 | `deepseek`（老用户升级后行为不变） |
| Qwen / Kimi 协议 | OpenAI 兼容模式（复用 OpenAI 兼容适配器，只配 baseUrl + 模型名） |
| Anthropic 协议 | 原生 Messages API（新建 `AnthropicProvider`） |
| 可插拔粒度 | Provider 描述可注册（`registerProvider`），协议适配器固定为 2 个 |
| Anthropic 客户端 | `@anthropic-ai/sdk`（与现有 `openai` SDK 对称，注入 client 便于测试） |
| 认证 | 不做 pi 式 auth/oauth，只按 provider 描述里的 `apiKeyEnv` 读环境变量 |
| 全局配置目录 | `~/.blh/`（对齐 pi 的 `~/.pi/`，去掉 `.config` 层级） |
| 项目配置目录 | `.blh/`（对齐 pi 的 `.pi/`，替换散文件 `.blh.yaml`） |
| 配置拆分 | `config.yaml`（模型/运行时）+ `mcp.yaml`（MCP）+ `settings.json`（记忆） |
| MCP 配置 | 从 `config.yaml` 拆到独立 `mcp.yaml`；全局/项目按 name 合并，项目覆盖同名 |
| 迁移策略 | 硬切换新路径，不保留旧路径运行时兼容；实现时一次性把现有 `.blh.yaml` 内容迁到新结构 |

## 3. 目录与架构

```
src/providers/
  catalog.ts        新增：ProviderDefinition 类型 + 4 个内置描述 + getProviderDefinition/listProviders/registerProvider/findFirstConfiguredProvider
  registry.ts       新增：createProvider(config) 工厂，按 def.api 分派到适配器
  openai-compat.ts  重命名自 openai.ts：OpenAIProvider → OpenAICompatProvider
  anthropic.ts      新增：AnthropicProvider（原生 Messages API）
  errors.ts         新增：抽出 isPromptTooLong（兼容 OpenAI + Anthropic 两种报错格式）
  retry.ts          不变

src/core/
  settings.ts       新增：loadSettings/saveSettings，读写 ~/.blh/settings.json 记忆上次显式指定的 provider/model
```

运行时配置目录（对齐 pi 的 `.pi/`）：

```
~/.blh/               全局（用户级）
  config.yaml         模型/API/运行时配置
  mcp.yaml            全局 MCP 服务器（可选）
  settings.json       上次显式选择的 provider/model（记忆）

.blh/                 项目级（从 cwd 向上找第一个）
  config.yaml         项目配置（覆盖全局同名项）
  mcp.yaml            项目 MCP 服务器（按 name 合并，项目覆盖全局同名）
```

数据流：`loadConfig` 解析 `provider` id → `createProvider(config)` 查 `catalog` 得到描述 → 解析 baseUrl/model/apiKey → 按 `def.api` 分派到 `OpenAICompatProvider` 或 `AnthropicProvider` → 返回 `ChatProvider`。

要加新厂商 = 在 `catalog.ts` 加一条描述（或调 `registerProvider`），无需动适配器。

## 4. 核心类型

```ts
// core/types.ts 新增
export type ProviderId = "deepseek" | "anthropic" | "qwen" | "kimi" | (string & {});
export type ProviderApi = "openai" | "anthropic";

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  api: ProviderApi;            // 走哪个协议适配器
  baseUrl: string;             // 默认 baseUrl（可被 config.baseUrl 覆盖）
  apiKeyEnv: string[];         // 依次尝试的环境变量名
  defaultModel: string;        // 默认模型（可被 config.model 覆盖）
  models?: string[];           // 已知模型提示（可选，仅文档用途）
}

// ChatProvider 增加（可选，与 stream 一致，避免破坏测试 mock）：
chatCompletion?(messages, maxTokens?): Promise<{ message: ChatMessage; usage: ChatUsage }>;

// Config 增加：
provider: string;   // 解析后的 provider id（来自显式配置 / settings 记忆 / 自动检测 / 兜底 deepseek）
```

## 5. 内置 Provider 描述

| id | api | baseUrl | apiKeyEnv | 默认模型 |
|---|---|---|---|---|
| deepseek | openai | `https://api.deepseek.com` | `DEEPSEEK_API_KEY`（兼容回退 `OPENAI_API_KEY`） | `deepseek-chat` |
| anthropic | anthropic | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| qwen | openai | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen-max` |
| kimi | openai | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `moonshot-v1-8k` |

> 默认模型名以厂商当前上架为准，用户通过 `--model` 覆盖，不影响架构。

catalog 里 provider 的定义顺序即「自动检测默认」的优先级顺序：deepseek → anthropic → qwen → kimi。这样老用户（只配了 DeepSeek key）升级后默认仍是 deepseek。

## 6. 工厂与注册表

```ts
// registry.ts
export function createProvider(config: Config): ChatProvider {
  const def = getProviderDefinition(config.provider);   // 未知 id 直接抛错
  const resolved: Config = {
    ...config,
    baseUrl: config.baseUrl ?? def.baseUrl,
    model: config.model,                                  // loadConfig 已填默认
    apiKey: resolveApiKey(config, def),                   // file.api_key → env[apiKeyEnv...]
  };
  return def.api === "anthropic" ? new AnthropicProvider(resolved) : new OpenAICompatProvider(resolved);
}
```

`resolveApiKey` 优先级：`config.apiKey`（配置文件 `api_key` 字段）→ `def.apiKeyEnv` 按顺序查环境变量 → 都没有则抛错并列出该设置哪个环境变量。

`catalog.ts` 为纯数据模块（无 SDK 依赖），使 `config.ts` 可 import 它解析默认值而不引入 SDK。`registry.ts` 才 import 适配器（引入 SDK）。

`catalog` 还提供 `findFirstConfiguredProvider(env)`：按定义顺序返回第一个 `apiKeyEnv` 中有非空环境变量的 provider，供 `loadConfig` 做「自动检测默认」。

## 7. Anthropic 适配器要点

- 用 `@anthropic-ai/sdk`，注入 client 便于测试（同 `ChatCompletionsClient` 注入模式）。
- **消息转换**：`ChatMessage[]`（OpenAI 风格）→ Anthropic `system` 顶层字段 + `user`/`assistant` 消息块；`assistant.tool_calls` → `tool_use` 块；`role:"tool"` → 按 `tool_call_id` 匹配的 `tool_result` 块。
- **工具转换**：`ToolDefinition.parameters` → `input_schema`。
- **max_tokens 必填**：调用链里 `maxTokens` 常为 `undefined`，适配器内给默认值（8192）。
- **流式映射**：Anthropic SSE（`content_block_start` / `content_block_delta` / `message_delta`）→ 现有 `ProviderStreamEvent`（`text_delta` / `tool_call_delta` / `done` + usage）。
- **chatCompletion**：无 tools 单轮并返回 usage（对齐 OpenAI 适配器的记账能力）。

## 8. 配置、默认选择与 CLI

### 8.1 provider 解析优先级

`loadConfig` 解析 `provider` 的完整优先级（从高到低）：

1. CLI `--provider`
2. 环境变量 `BLH_PROVIDER`
3. 配置文件 `.blh/config.yaml` / 全局 `~/.blh/config.yaml` 的 `provider:` 字段
4. `~/.blh/settings.json` 记忆的 provider（且该 provider 有非空 key）
5. catalog 顺序里第一个 `apiKeyEnv` 有非空环境变量的 provider
6. 兜底 `deepseek`

其中 1~3 属于「显式指定」，4~6 属于「自动兜底」。

### 8.2 model 解析优先级

1. CLI `--model`
2. 环境变量 `OPENAI_MODEL`
3. 配置文件 `model:` 字段
4. `settings.json` 记忆的 model（仅当记忆的 provider 被采用时）
5. 选中 provider 的 `defaultModel`

`baseUrl` 类似：CLI/env/file → provider 描述里的 `baseUrl`。

### 8.3 settings.json 记忆

- 位置：`~/.blh/settings.json`（全局唯一，与全局 `config.yaml` 同级）。
- 内容：`{ "provider": "anthropic", "model": "claude-sonnet-4-5" }`。
- 写入：仅当 provider/model 来自显式指定（上面 1~3）时写入；自动检测（4~6）不写入，避免把「系统兜底结果」固化成下次默认。
- 读取：记忆的 provider 若当前没有有效 key，则跳过，回退到自动检测。

### 8.4 apiKey 解析

- `loadConfig` 里的 `apiKey` 只从配置文件 `api_key` 字段读取（可为空字符串）；环境变量 key 的读取交给 `createProvider` 的 `resolveApiKey`（按 `def.apiKeyEnv` 顺序），避免 config 层硬编码某一家厂商的 env 名。
- 缺 key 时报错并**列明该设置哪个环境变量**。

### 8.5 配置目录与文件拆分

全局 `~/.blh/` + 项目 `.blh/` 两层，每层拆三个文件：

| 文件 | 职责 | 层级 |
|---|---|---|
| `config.yaml` | 模型/API/运行时（provider、model、api_key、base_url、bash_timeout、max_output_chars、workdir 等） | 全局 + 项目 |
| `mcp.yaml` | MCP 服务器列表 | 全局 + 项目 |
| `settings.json` | 上次显式选择的记忆 | 仅全局 |

- **config.yaml 加载顺序**：全局 `~/.blh/config.yaml` → 项目 `.blh/config.yaml`（从 cwd 逐级向上找，项目覆盖全局），再走 env → CLI（沿用现有 `get()` 优先级）。
- **mcp.yaml 加载顺序**：全局 `~/.blh/mcp.yaml` → 项目 `.blh/mcp.yaml`，按 `name` 合并，项目覆盖同名条目。
- **旧字段移除**：`config.yaml` 不再有 `mcp_servers` 字段，MCP 列表统一走 `mcp.yaml`。
- **迁移**：硬切换，不保留旧路径运行时兼容。实现时把现有 `.blh.yaml`（含 `mcp_servers`）拆到 `.blh/config.yaml` + `.blh/mcp.yaml`。

### 8.6 CLI

- 新增 `--provider` 参数（`values.provider` → `cli.provider`）。
- 移除「硬编码 `gpt-4o-mini` 默认模型」和「只认 `OPENAI_API_KEY`」的逻辑。
- 更新 `.env.example`、`USAGE` 帮助文案、`README.md`（配置路径从 `.blh.yaml` 改为 `.blh/config.yaml`）。

## 9. workflow 兼容

`chatCompletion` 上提到 `ChatProvider` 接口（**可选**，避免破坏 8 个测试 mock）。`OpenAIWorkflowRunner` 构造器改为接收 `ChatProvider`，缺 `chatCompletion` 时构造即抛错（只有 workflow 才需要它）。

## 10. 错误处理

- 未知 `provider` id → 明确报错并列出可用 provider。
- 缺 API key → 明确报错并列出该设置哪个环境变量。
- Anthropic 上下文超长 → `isPromptTooLong` 兼容两种报错格式（OpenAI 关键词 + Anthropic 关键词），供 loop 被动压缩重试。

## 11. 测试策略

- `catalog`：provider 解析、未知 provider 抛错、`findFirstConfiguredProvider`（有 key 检测顺序）。
- `registry`：apiKey 回退顺序、api 分派（openai vs anthropic）。
- `settings`：读写 settings.json、损坏文件容错、仅显式指定才写入。
- `config`：provider/model 完整优先级回退（含 settings 记忆、自动检测、兜底 deepseek）；全局/项目 `config.yaml` 合并；`.blh/` 目录向上查找。
- `mcp 配置`：`mcp.yaml` 拆分加载、全局/项目按 name 合并（项目覆盖同名）。
- `anthropic` 适配器：mock client，验证消息转换、工具转换、流式映射、max_tokens 默认值。
- 复用：`openai-compat` 沿用现有 `openai.test.ts`（改 import）。

## 12. 变更文件清单

- 新增 `src/providers/catalog.ts`、`registry.ts`、`anthropic.ts`、`errors.ts`。
- 新增 `src/core/settings.ts`。
- 重命名 `src/providers/openai.ts` → `openai-compat.ts`（类名 `OpenAICompatProvider`）。
- 修改 `src/core/types.ts`、`src/core/config.ts`（目录迁移 + mcp 拆分 + provider 解析）、`src/cli/main.ts`、`src/cli/buildHarness.ts`、`src/workflow/runtime.ts`。
- 迁移配置：`.blh.yaml` → `.blh/config.yaml` + `.blh/mcp.yaml`；全局 `~/.config/blh/` → `~/.blh/`。
- 修改 `package.json`（新增 `@anthropic-ai/sdk`）、`.env.example`、`README.md`。
- 新增 `test/providers/catalog.test.ts`、`test/providers/anthropic.test.ts`、`test/core/settings.test.ts`；调整 `test/providers/openai.test.ts` 与 `test/core/config.test.ts`。

## 13. 非目标（YAGNI）

- 不做 pi 式 OAuth / credential-store / 多认证方式。
- 不做模型成本目录（cost）、上下文窗口/图片/思考等级等元数据。
- 不做运行时协议自定义（自定义 provider 只能选 `openai` 或 `anthropic` 两种既有协议）。
- 不改 loop/harness/agents/memory/compaction 等核心逻辑（除 `isPromptTooLong` 抽出与 workflow 的 `chatCompletion` 上提）。
- 本次不迁移 `skills` 目录（仍留在 `<workdir>/skills`）与 session/memory 等工作目录资源，只重构「配置」这一层。
