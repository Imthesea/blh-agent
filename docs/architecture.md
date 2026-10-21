# 架构总览（Architecture Overview）

> 本文是**当前实现**的单一事实源索引。历史演进与逐条决策见 `docs/plans/`、`docs/superpowers/`；若两者冲突，以本文 + 代码为准。

## 1. 项目是什么

`blh` 是一个 TypeScript 编写的编码智能体 CLI，支持 REPL / `-p` 单次 / `web` 三种入口。核心能力：多轮 agent 循环、工具调用（bash / 文件读写等）、上下文压缩、会话事件溯源、记忆、定时任务、后台任务、队友（子 agent）、MCP 扩展，以及一个 Web 对话界面。

运行时要求 Node >= 20，构建产物 `dist/cli/cli.js`，源码经 `tsx` 直接运行（开发）。

## 2. 分层与模块地图

源码根目录 `src/`，18 个顶层模块。依赖方向由 `scripts/check-architecture.mjs` + `architecture.config.json` **机器强制**（`pnpm lint` 的一部分）：

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `contracts` | 领域类型与纯函数，**零依赖**（不能 import 其他模块） | `types.ts`、`estimate.ts`、`provider-errors.ts`、`truncate.ts` |
| `runtime` | agent 主循环、端口接口、钩子、事件总线 | `loop.ts`、`ports.ts`、`harness.ts`、`hooks.ts` |
| `session` | 会话事件溯源 + 持久化 + 清洗 | `transcript.ts`、`store.ts`、`sanitize.ts`、`daily-log.ts` |
| `compaction` | 上下文压缩（本地落盘 → 砍中间 → 摘要） | `compactor.ts` |
| `providers` | 各家 LLM 适配（统一 `ChatProvider`） | `catalog.ts`、`anthropic.ts`、`openai-compat.ts`、`retry.ts` |
| `tools` | 工具注册表与内置工具 | `registry.ts`、`bash.ts`、`files.ts` |
| `config` | 配置加载与解析 | `config.ts`、`env.ts` |
| `memory` | 记忆抽取/召回/dream | `extract.ts`、`recall.ts`、`store.ts` |
| `jobs` | 定时/后台任务 | `cron.ts`、`runtime.ts`、`background.ts` |
| `agents` | 队友与子 agent、worktree | `team.ts`、`teammate.ts`、`worktree.ts` |
| `extensions` | 技能加载、MCP | `mcp.ts`、`skills.ts` |
| `goals` / `planning` / `workflow` | 目标评估、计划、工作流 | — |
| `security` | 权限规则 + 破坏性命令检测 | `rules.ts` |
| `tracing` | 结构化追踪（JSONL 落盘） | `tracer.ts`、`store.ts` |
| `process` | 子进程输出解码 / 进程树终止 | `output.ts`、`terminate.ts` |
| `cli` | **组合根**：装配所有依赖，只有它知道全局 | `buildHarness.ts`、`cli.ts`、`main.ts`、`web.ts` |

**硬规则**（架构校验）：`contracts` 不可反向依赖；`runtime` 不可 import 任何 feature；feature 不可 import `cli`。feature 间跨边依赖必须显式登记在 `architecture.config.json` 的 `allowedFeatureEdges`。

## 3. 三个关键机制

### 3.1 会话事件溯源（`session/`）
- 事实来源是 append-only 的 `SessionEvent` 列表（`message` / `compaction` / `rollback` / `messageCancelled`），持久化到 `.sessions/session_*.jsonl`，seq 严格递增。
- 内存视图（`Transcript.projected` / `summaryText`）由事件**重放投影**得到；`append/compact/rollbackTo/cancelMessage` 都必须提交事件，保证日志与内存一致。
- `Transcript.compact` 把摘要存为**元数据**（`summary` 字段），不再伪造一条消息。
- 注意：**已移除 v0 旧格式（裸消息行）读取**——`loadSession` 直接跳过非事件行。

### 3.2 agent 主循环（`runtime/loop.ts`）
每轮：注入后台结果 → 压缩预算重算 → 准备模型输入（`injectArchivedSummary` 把摘要并入 system + `sanitizeReplay` 清洗）→ 调模型（流式优先、失败回退非流式）→ 执行工具 → 目标检查 → 收尾（todo 提醒 / 主动压缩）。截断的 tool_call 会被丢弃并落盘半成品。

### 3.3 上下文压缩（`compaction/compactor.ts`）
按成本从低到高：`toolResultBudget`（大结果落盘）→ `snipCompact`（砍中间）→ `microCompact` → `fitToolResults` → `compactHistory`（调模型摘要，最后手段）。所有切点都保护 tool 调用配对边界。

## 4. 共享契约（跨 runtime 与 UI）

- **包边界**：`packages/web-protocol` 是 runtime 与 Web UI 的**共享契约包**（wire 类型 `AgentEvent`、`ChatMessage`、`SessionInfo` 等）。根包 `src/contracts/` 有自己的更丰富类型（`finishReason` 等），两者**有意分离**：web-protocol 是线上格式，src/contracts 是内部领域模型。
- **工具结果结局契约**：`ToolOutcome`（`ok|error|denied`）与 `classifyToolOutcome()` 定义在 `packages/web-protocol`，是判定工具结果的**唯一实现**；runtime（`loop.ts`）与 UI（`turns.ts`）都复用，不再各自写 `startsWith("error:")`。生产者（`tools/registry.ts`）用 `TOOL_ERROR_PREFIX` / `TOOL_DENIED_PREFIX` 常量。

## 5. 命令

```bash
pnpm typecheck            # 根包类型检查
pnpm lint                 # eslint + 架构校验
pnpm test                 # 根包 vitest
pnpm --filter @blh/web test           # Web 组件/纯函数单测
pnpm --filter @blh/web typecheck
pnpm build                # 构建 CLI
pnpm build:web            # 构建 Web 前端
```

## 6. 约定

- 严格 TS：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitReturns`。
- ESLint 禁用 `any`、强制命名规范（camelCase）；OpenAI snake_case 字段有显式豁免。
- 日志走 `@blh/logger`（`createLogger`）；`console.*` 仅限 CLI 的 stdout/stderr 正常输出。
- 文件 I/O 以同步为主（CLI 取舍）；大结果写盘用 append-only JSONL。
