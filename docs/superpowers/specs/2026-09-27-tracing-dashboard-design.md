# Trace 体系与观测面板设计

- 日期：2026-09-27
- 状态：待审查
- 参考：waku-agent（`F:\allProject\githubProject\new-waku-agent\waku-agent`）的 `waku/ops/tracing.py` 与 `waku/ops/dashboard.py`

## 1. 背景与目标

项目已有按模块的 logger（`.blh/logs/`）、6 种事件的 EventBus、HookBus、JSONL session 落盘，以及完整的 web 工作台（`@blh/web-server` + `apps/web`）。但缺少**结构化、可回看的 trace**：LLM 调用的 token/耗时/重试、工具调用的参数/耗时/审批结果、压缩/记忆/目标评估等内部决策，目前要么只混在文本日志里，要么根本不落地，事后无法回答"模型为什么这样回、agent 做了什么、上下文为什么变了、钱花在哪"。

目标：参考 waku 的 trace 体系，为全环节埋点，JSONL 落盘，并在现有 web 工作台中加观测页（Overview / Trace / Ops），用于追踪调查各个环节。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 集成形态 | 扩展现有 web 工作台（web-server 加只读 API，apps/web 加观测页），不做独立 dashboard 进程 |
| 事件通道 | 独立 Tracer 模块，双轨采集：关键点位直接埋点 + 订阅 EventBus 的 turn 边界；不扩容 `AgentEvent` union |
| 存储 | `<workdir>/.blh/traces/YYYY-MM-DD.jsonl`（每日事件流）+ `<workdir>/.blh/usage.jsonl`（永久 token 账本），与 session JSONL 风格一致，不引入 SQLite |
| 成本口径 | token 是真相、价格是推导：账本只记 token，读时按价格表换算，改价可追溯修正历史 |
| 数据投递 | `GET /api/trace/events?cursor=N` 按行号游标增量读文件，前端 1s 轮询——CLI 模式写的 trace 也能被 web 旁观，两种模式天然打通 |
| OTel / 实时架构点亮图 / CLI 查看器 | 本期不做（见非目标） |

## 3. 架构

### 3.1 新增 `src/tracing/` 模块（根包）

```
src/tracing/
  types.ts    # TraceEvent 信封与事件 payload 类型
  tracer.ts   # Tracer：event() 追加写 traces 文件；llm 事件顺带写 usage 账本
  fold.ts     # 事件流折叠为 turn 结构（供 web-server 与测试复用）
  pricing.ts  # 价格表与成本换算（纯函数）
test/tracing/
  tracer.test.ts / fold.test.ts / pricing.test.ts
```

### 3.2 事件模型（`types.ts`）

统一信封：`{ ts, type, sid, turn, ...payload }`

- `ts`：UTC 毫秒时间戳（写入时自动加盖）
- `sid`：会话 id（取自 session 文件名 / web SessionManager 的会话标识）
- `turn`：会话内第几轮（Harness.runTurn 每次调用递增）

事件类型与埋点位置：

| type | payload | 埋点位置 |
|------|---------|----------|
| `turn_start` | `user_message` | 订阅 EventBus `turn_start` |
| `turn_end` | `iterations, tools_used, latency_ms, cost_usd` | 订阅 EventBus `turn_end`（`cost_usd` 为写入时按价格表换算的快照，仅用于卡片速览；Ops 成本统计一律以 usage 账本重算为准） |
| `turn_cancelled` | `reason` | 订阅 EventBus `turn_cancelled` |
| `llm` | `provider, model, iteration, stop_reason, usage:{in,out}, latency_ms, retries, stream, error?` | `src/core/loop.ts` 调 provider 处（含流式回退路径） |
| `tool` | `tool, args_summary, latency_ms, status(ok/error/denied), output_summary, background?` | `loop.ts` 工具分发前后 |
| `approval` | `tool, decision(allow/deny/ask), rule?, source(cli/web)` | `src/security/approval.ts` permission hook |
| `compact` | `kind(proactive/reactive), before_msgs, after_msgs` | `src/compaction/compactor.ts` |
| `memory` | `action(recall/extract), hits? / new_facts?` | `src/memory/recall.ts` / `extract.ts` |
| `goal` | `status(continue/block/complete), reason` | `src/goals/` 目标控制器 |
| `subagent` | `name, status(spawn/result), latency_ms?` | `src/agents/subagent.ts` |
| `job` | `kind(cron/background), name, status` | `src/jobs/cron.ts` / `background.ts` |
| `workflow` | `workflow, stage, status, ms?` | `src/workflow/runtime.ts` |

摘要字段（`args_summary` / `output_summary`）截断到约 500 字符，避免单条事件过大；完整内容本就在 session 文件里，trace 只承担索引与调查线索职责。

流式 token 用量：OpenAI 兼容流式需带 `stream_options:{include_usage:true}` 才返回 usage（`src/providers/openai-compat.ts` stream 路径补充）；Anthropic 流式从 `message_start`/`message_delta` 事件取 usage。取不到时 `usage` 记 `null`，账本跳过该条，不估算。

### 3.3 Tracer（`tracer.ts`）

- `tracer.event(type, payload)`：盖 `ts/sid/turn` 后同步追加写当日 traces 文件（`node:fs` `appendFileSync`，与 session store 同款写法）。
- `llm` 事件且 `usage` 非空时，额外写一行账本 `{ts, sid, provider, model, in, out}` 到 `usage.jsonl`。
- 按本地日期轮换文件名（与 logger 的按日滚动一致）。
- **失败隔离**：所有写入 try/catch 包裹，失败经 `@blh/logger` 记一次 warn 后静默——trace 挂了绝不影响 agent 循环。
- Tracer 挂到 Harness：作为 EventBus 订阅者接收 turn 边界事件；`sid` 与 `turn` 计数器由 Harness 在 `runTurn` 时推进。

### 3.4 价格表（`pricing.ts`）

- 内置表：deepseek / qwen / kimi / anthropic 各模型的 input/output 每 1M token 价格。
- `costFor(model, in, out): number | null`：未知模型返回 `null`，前端显示 "—"。
- `usageSummary(workdir)`：读 `usage.jsonl`，返回 all-time / 按天 / 按 provider / 按模型的 token 与成本汇总。纯函数，可单测。

### 3.5 web-server 新增只读 API（`apps/web-server/src/trace.ts`）

| 端点 | 行为 |
|------|------|
| `GET /api/trace/overview` | 总花费 / turns / 工具调用数 / 平均延迟 / 按天与按 provider 成本（fold + usageSummary 聚合） |
| `GET /api/trace/turns?sid=&date=&limit=` | 指定日期（默认当天）事件折叠为 turn 卡片：每次 LLM 迭代、工具行、审批记录、耗时/迭代数/成本；未闭合 turn 标记 `unfinished` |
| `GET /api/trace/events?cursor=N` | 按行号游标读当日文件，返回 `{events, nextCursor}`；前端 1s 轮询实现近实时跟随 |
| `GET /api/trace/files` | 列出 traces 目录下的日期文件 |

约束与现有路由一致：仅绑回环地址、Host 回环校验；GET 无 CSRF 要求但全部只读，不写任何文件；坏行（非 JSON）跳过；`date` 参数校验 `YYYY-MM-DD` 格式防路径穿越。traces 读取路径取 web-server 的 workdir——与 CLI 同目录启动即可旁观 CLI 会话。

### 3.6 前端观测页（`apps/web`）

侧边栏新增 "Observe" 区，hash 路由 `#/observe/overview|trace|ops` 三个 tab，数据经 `@blh/web-client` 新增 `traceApi` 封装。**不新增依赖**（图表用纯 CSS/SVG，markdown 渲染复用现有组件）。

- **Overview**：统计卡片（总花费 / turns / 工具数 / 平均延迟）+ 近 14 天成本条形图 + 最近 5 个 turns 摘要。
- **Trace**：会话选择器 + 日期选择器；turn 卡片列表——用户消息、每次 LLM 迭代行（model/usage/耗时）、工具调用行（状态点 + 可展开 args/output 摘要）、审批徽标、脚注（耗时/迭代数/成本）；`events?cursor` 1s 轮询自动跟随最新 turn，unfinished turn 显示进行中态。
- **Ops**：成本表（按天 / provider / 模型）、最慢 10 个 turns、审批决策表（allow/deny/ask 计数 + 明细）、trace 原文浏览（最近 200 行）。

### 3.7 数据流

```
CLI / Web 模式 ──埋点+EventBus──▶ Tracer ──▶ .blh/traces/YYYY-MM-DD.jsonl
                                       └─▶ .blh/usage.jsonl（llm 事件）
blh web ──▶ GET /api/trace/*（读文件，游标/全量）──▶ React 观测页
```

## 4. 错误处理

- Tracer 写失败：warn 一次后静默，不影响 loop（3.3）。
- 读侧坏行跳过；当日文件不存在返回空列表而非 404（前端显示空态）。
- 流式取不到 usage：事件 `usage:null`，账本跳过，成本显示 "—"。
- 价格表缺模型：成本 `null`，token 数仍正常统计。

## 5. 测试策略（Vitest）

- `test/tracing/tracer.test.ts`：event 写入信封字段（ts/sid/turn）、按日轮换、llm 事件写账本、usage 为 null 跳过账本、写入失败静默不抛。
- `test/tracing/fold.test.ts`：turn_start..turn_end 折叠、llm/tool/approval 归位、未闭合 turn 标 unfinished、坏行跳过。
- `test/tracing/pricing.test.ts`：已知模型换算、未知模型 null、usageSummary 按天/provider 汇总。
- `test/core/loop.test.ts` 增补：跑一个 mock turn，断言产生 turn_start/llm（带 usage）/tool/turn_end 事件。
- `apps/web-server/test/trace.test.ts`：四个端点、游标语义（cursor 增量、越界归位）、date 格式校验、只读（POST 405/404）。
- 回归：`pnpm test` 全量 + typecheck + build；`@blh/web` typecheck + build。

## 6. 非目标（YAGNI）

- 不做实时架构点亮图（waku 的 SVG 动画），本期用 1s 轮询的 turn 卡片跟随替代。
- 不做 OpenTelemetry 导出（后续可作为 Tracer 的第二个 sink 增量加入）。
- 不做 CLI `trace` 查看器命令。
- 不做 trace 文件清理/归档策略（与日志一样按日滚动，手动管理）。
- 不改现有 EventBus 事件类型与 web 聊天链路任何行为。
