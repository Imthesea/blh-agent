# 持久化冗余与健壮性修复方案

> 生成依据：`skills/boundary-check`（防无限膨胀 5 步清单）+ `diagnosing-bugs`（实测落盘数据）+ 本次对 `.sessions/`、`.blh/traces/`、`.blh/logs/`、`.blh/usage.jsonl` 的实际采样。
> 原则：合理性、健壮性优先；允许大改动、允许改接口。

## 0. 结论先行（问题 → 根因 → 修复）

| # | 问题（实测证据） | 根因 | 修复方向 |
|---|---|---|---|
| A1 | usage 双写：`trace.llm.usage` 与 `.blh/usage.jsonl` 存同一份 token 数 | 两个独立写入点 | ✅ 单一事实源：trace 为唯一 token 源，删除 usage.jsonl，usage 由 trace llm 事件聚合 |
| A2 | `chat/{day}.md` 是第 4 份全文对话副本（118KB） | `appendDailyLog` eager append 全文 | 改为按需渲染（读 session 投影生成），或只存逐轮摘要 |
| A3 | `compactor.persistedPreview` 为取 2000 字预览全量读文件 | `readFileSync(...).slice(0,n)` | 有界读（fd + read 前 N 字节） |
| A4 | `cost_usd` 恒 0 | `pricing.ts` 缺 `deepseek-flash` 价格，`costFor` 返回 null | ✅ 补 DeepSeek 官方定价（cache-miss + off-peak）+ 未知模型显式告警 |
| A5 | log 同一错误 45 条、每条 ~1KB 完整命令 | logger 无去重/无截断 | logger 层加 dedup + 长字段截断 |
| B1 | `pre_tool_use` hook 正则崩溃，且 **fail-open** | `HookBus.firstBlock` 吞异常当「未拦截」 | 安全 hook 失败关闭 + 修正则构造转义 |
| B2 | `<reminder>Update your todos.</reminder>` 注入 13 次 | `TodoManager.noteRound` 纯计数器、不检查 todo 是否真的过期 | 有界提醒：无未完成项不提醒 + 每轮/每回合上限 |
| B3 | 一次 40 轮 / 58 工具 / 174s 后 abort 的失控回合 | 无回合预算、无重复命令熔断 | 回合熔断：max iterations + 相同命令重复检测 + 无进展检测 |
| C1 | 日志里 45 条 `hawaii/` 任务错误，对应不到任何 session | 日志按天、会话删除/清理不同步 | 会话删除时清理归属日志，或日志携带 session id 并可追溯 |

---

## 1. 组 A：追加型存储的膨胀与冗余

### A1. usage 单一来源：trace 为唯一 token 源（✅ 已实施）

**根因**：`tracer.ts` 的 `llm` 事件写 `usage.promptTokens/completionTokens`，同时 `tracer.ts:112` 又写一行 `.blh/usage.jsonl`；两者是同一 token 数的两份落盘，且消费方不一致：`TracePage` 读 trace 的 `e.usage`，`TraceStore.usage()` 读 usage.jsonl。

**决策**（用户确认）：选 **方案 A** —— trace 成为唯一 token 源，删除 usage.jsonl。

**实施**：
- `tracer.ts`：删除 `recordUsage` 里写 usage.jsonl 的逻辑；保留按回合 `cost_usd` 累加（读 `llm.usage` 现场算价）。
- `pricing.ts`：删除读 usage.jsonl 的 `usageSummary()`；`UsageRecord` 改为泛化的 `UsageLine`；新增 `mergeUsageSummaries()` 合并按天聚合。
- `types.ts`：删除 `UsageRecord`。
- `store.ts`：`TraceStore.usage()` 改为从各 trace 文件的 `llm` 事件聚合；按天 `JsonlTail` 增量读 + 按天 `UsageAccumulator`，并剔除已删除日期文件的旧累积；`listTraceDates` 移入本文件供 module 复用。
- 前端无改动：`TracePage` 已读 `e.usage`，Ops/Overview 的 `usage` 形状不变。

**涉及文件**：`src/tracing/{tracer,pricing,types,store,module}.ts`、`test/tracing/*`、`test/agents/{subagent,teammate}.test.ts`、`test/runtime/loop.test.ts`。

**历史数据**：旧 `.blh/usage.jsonl` 不再读取，自然废弃；如需迁移可用一次性脚本从既有 trace 文件重建（本次未做）。

**成功标准**：新进程不再生成 usage.jsonl；`TraceStore.usage()` 从 trace 聚合结果与原 usage.jsonl 语义一致；追加 1 次 llm 后 usage 不翻倍（`store.test.ts` 增量断言）。

### A2. `chat/{day}.md` 从「eager 全文 append」改为「按需渲染」（改接口，推荐）

**根因**：`src/session/daily-log.ts` 的 `appendDailyLog` 每轮把整段对话渲染成 markdown 追加（我上一轮只修了「每轮只追加增量」，但仍是全文副本）。

**方案**：
- 删除 `appendDailyLog` 的 eager 写入；改成一个**纯函数** `renderDailyLog(sessionStore)`，在 web-server 的 `GET /api/session/export`（或一个 `/api/chat-log?date=`）里按需从 session 投影生成。
- 或者保留落盘、但内容降级为「每轮一句话摘要」而非全文（更省，但失去 audit 价值）。
- 推荐前者：audit 需求由 session jsonl 本身满足，markdown 只是「人类可读视图」，不该是第二个事实源。

**涉及文件**：`src/session/daily-log.ts`、`src/runtime/harness.ts`（去掉 `logTurn` 调用链）、`apps/web-server` 新增只读渲染接口、`test/session/daily-log.test.ts` 改为测渲染函数。

**风险/缓解**：去掉自动落盘会丢失「崩溃后仍有人类可读留档」——由 session jsonl 兜底（它先落盘），影响面可控。

**成功标准**：不再有 `.sessions/chat/` 自动增长；`/api/chat-log` 按需渲染与旧内容等价。

### A3. `persistedPreview` 有界读

**根因**：`src/compaction/compactor.ts:141` `readFileSync(savedPath, "utf8").slice(0, previewChars)` 为取预览读了整文件。

**方案**：用 `openSync` + `readSync` 只读前 `previewChars*4` 字节（UTF-8 上限），或复用 `src/tracing/store.ts` 的 JsonlTail 思路。

**涉及文件**：`src/compaction/compactor.ts`、`test/compaction/compactor.test.ts`。

**成功标准**：新增测试——对 10MB 落盘文件取 2000 字预览，断言读取字节数 `stat().size` 不再随文件大小线性增长（或直接断言读到的是前 N 字节）。

### A4. `cost_usd` 恒 0：补价格表 + 未知模型告警（✅ 已实施）

**根因**：`src/tracing/pricing.ts` 的 `MODEL_PRICES` 没有 `deepseek-flash`，`costFor` 返回 null，`tracer.ts` 只在非 null 时累加，于是 `cost_usd` 恒 0。

**官方定价**（2026-10-21 查 `api-docs.deepseek.com/quick_start/pricing`，单位 USD / 1M tokens，区分 cache hit/miss 与 off-peak/peak）：
- `deepseek-flash`：cache-miss 输入 off-peak **$0.15** / peak $0.3；输出 off-peak **$0.6** / peak $1.2。
- `deepseek-v4-pro`：cache-miss 输入 off-peak **$0.66** / peak $1.32；输出 off-peak **$1.98** / peak $3.96。
- 旧名 `deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-flash*` 官方已按 Flash 计费。

**方案**：
- 价格表取 **cache-miss + off-peak** 作为基础价（不含 cache 命中优惠、不区分峰谷），并加注释说明。
- 新增 `deepseek-flash`、`deepseek-v4-pro` 条目；用 `deepseek` 兜底匹配所有 legacy DeepSeek 模型到 Flash 价。
- `costFor` 返回 null 时，tracer 对**首次**遇到的未知模型 `log.warn`，不再静默。

**涉及文件**：`src/tracing/pricing.ts`、`src/tracing/tracer.ts`、`test/tracing/pricing.test.ts`、`test/tracing/tracer.test.ts`。

**成功标准**：`cost_usd` 不再恒 0；未知模型有告警日志（跨 Tracer 实例只告警一次）。

### A5. logger 去重 + 长字段截断

**根因**：`packages/logger` 的 `node.ts` 把 `fields` 原样 JSON 序列化，长字符串（整条命令/正则）不截断，同一错误连续打印无去重。

**方案**：
- logger 加**可配置的字段截断**（默认 512 字符，超过打 `…[truncated N chars]`）。
- 加**同 key 短窗口去重**（如 5 秒内同 `module+msg` 只打一次 + `×N` 计数），避免 45 条刷屏。
- 这两项默认开启，`debug` 级别可关。

**涉及文件**：`packages/logger/src/node.ts`、`packages/logger/src/browser.ts`（对齐）、`packages/logger/test/*`。

**成功标准**：单测——同一错误连打 45 次只落 1 行 + 计数；超长字段被截断。

---

## 2. 组 B：健壮性

### B1. hook 失败关闭（安全，最高优先）

**根因**：`src/runtime/hooks.ts` `firstBlock`/`trigger` 把 hook 抛异常吞掉并当作「未拦截」——安全类 hook（`pre_tool_use` 权限校验、`security/rules.ts` 正则）一旦崩，命令照常执行（fail-open）。本次实测正是这种情况：正则编译崩溃，命令继续跑。

**方案**（两处一起改）：
1. **修正则构造**：定位 `pre_tool_use` 里把 bash 命令当正则/把用户规则拼进 `new RegExp(...)` 的代码，做正确转义（`RegExp.escape` 或等价），从根上消除崩溃。
2. **HookBus 增加失败语义**：区分「hook 返回 null（放行）」与「hook 抛错（异常）」。对**安全类 hook**（pre_tool_use 的 firstBlock）失败关闭——抛错时返回一个明确的「阻断」结果（`denied: hook error`），而不是放行；`trigger` 的普通 hook 仍可容错。

**涉及文件**：`src/runtime/hooks.ts`、`src/runtime/loop.ts`（消费 firstBlock 结果）、`src/security/rules.ts`、`test/runtime/hooks.test.ts`、`test/runtime/loop.test.ts`。

**风险/缓解**：fail-closed 可能误伤合法命令（hook 有 bug 时全拦）→ 阻断信息里带 hook 错误，用户可见可恢复；并为「安全 hook 抛错」单独打 error 日志（不再只是 warn）。

**成功标准**：新测试——安全 hook 抛错时，命令被拦截且返回 `denied: ...`，而不是执行；正则构造测试覆盖含 `[`、`(`、`\` 的命令。

### B2. todo 提醒有界化

**根因**：`src/planning/todo.ts` `noteRound` 用纯计数器（每 3 轮没写 todo 就提醒一次），不判断 todo 是否真的过期，长回合里反复注入 `<reminder>`，既写进 session 又占上下文。

**方案**：
- 提醒条件改为：**存在未完成 todo 项** 且 距上次提醒 ≥ N 轮 且 本轮没有 todo_write；
- 加**每回合提醒上限**（如 1 次/回合）；
- 提醒内容不再伪装成 user 消息正文，改走 `isInternal`（已是）并**不再计入 `userRetentionIndex` 的 user 候选**（否则会污染压缩边界）。

**涉及文件**：`src/planning/todo.ts`、`src/runtime/loop.ts`、`test/runtime/loop.test.ts`、`test/planning/todo.test.ts`（如无则新增）。

**成功标准**：新测试——无未完成项时 `noteRound` 恒返回 null；长回合注入次数 ≤ 上限。

### B3. 回合熔断

**根因**：无 `maxIterations`/重复命令检测，40 轮 58 工具后被用户 abort。

**方案**（分两步，第二步更激进）：
1. **快速见效**：`runAgentLoop` 加 `profile.maxTurns`（已存在）之外，再加**连续相同 bash 命令的重复计数**——同一命令（规范化后）连续 ≥3 次且输出未变，注入一条「你已连续执行同一命令，先停下来说明原因」的提醒，并计入熔断。
2. **更稳（推荐，改动大）**：把「回合预算 + 无进展检测」做成一个 `TurnGuard` 端口，组合根注入；超预算/无进展时**优雅结束回合并落一个 `turn_cancelled(reason: "stalled")`**，而不是等用户 abort。

**涉及文件**：`src/runtime/loop.ts`、`src/runtime/ports.ts`、`src/runtime/harness.ts`、`test/runtime/loop.test.ts`。

**成功标准**：新测试——脚本化 provider 让 agent 连续跑同一命令 N 次，断言在熔断阈值处回合自动结束、trace 记 `stalled`。

---

## 3. 组 C：生命周期一致性

### C1. 日志/会话生命周期对齐

**根因**：log/trace 按天落盘，session 按会话落盘；会话删除/清理后，其日志残留（本次 45 条 hawaii 错误对不上任何 session）。

**方案**：
- 让 log/trace 的每条记录**携带 `sid`**（trace 已有 sid，log 没有——给 log 加）；
- `SessionStore.remove` 时，同步清理该 sid 的日志（或标记为 orphan）；
- 至少：web-server 的 session 删除接口增加「清理该 session 的 trace/log 行」步骤。

**涉及文件**：`packages/logger/src/node.ts`（log 加 sid 上下文）、`src/tracing/tracer.ts`、`apps/web-server/src/session.ts`、`apps/web-server/src/http/routes/session.ts`。

**风险/缓解**：日志按天混合多 session，按 sid 过滤删除需要行级标记——若成本过高，退而求其次：只做「删除会话时打一条明确的 delete 事件」，让日志可追溯。

**成功标准**：删除会话后，该 sid 的 log 行不再残留（或明确可追溯）。

---

## 4. 实施顺序（建议）

1. **B1（hook fail-closed + 正则转义）** —— 安全，独立，先做。
2. **B3 + B2（回合熔断 + todo 有界提醒）** —— 一起做，都改 loop.ts，顺带修掉 13 次提醒。
3. **A4 + A1（价格表 + usage 单一来源）** —— 数据正确性。
4. **A3 + A5（有界读 + logger 截断/去重）** —— 纯性能/噪声。
5. **A2 + C1（chat 渲染化 + 生命周期对齐）** —— 结构性改动，最后做，留出回归窗口。

## 5. 边界审查登记（boundary-check 5 步）

新增/遗漏的追加型数据点必须登记进 `skills/boundary-check/references/registry.md`：

| 数据点 | 5 步结论 |
|---|---|
| `<workdir>/.blh/logs/blh-{day}.log` | **未登记**。读取无书签（全量）、无保留策略 → 补：按大小/天数滚动 + A5 截断去重 |
| `<workdir>/.sessions/chat/{day}.md` | **未登记**。A2 改为按需渲染后可移出「追加型」 |
| `<workdir>/.sessions/session_*.jsonl` | 追加但按会话有界；可接受，但需 C1 的删除对齐 |
| `<workdir>/.blh/traces/{date}.jsonl` | 已登记（JsonlTail 增量读）✅ |
| `<workdir>/.blh/usage.jsonl` | 已删除（A1 方案 A：trace 为唯一 token 源）✅ |
| `<workdir>/.task_outputs/*` | 追加但按会话；A3 有界读后无需登记 |

---

## 6. 回归测试总清单

- trace：usage 单源、cost 非 0、旧 trace 行容错
- logger：去重、截断
- hooks：安全 hook fail-closed、正则转义
- loop：回合熔断、todo 提醒上限
- compactor：persistedPreview 有界读
- web-server：session 删除对齐日志
- daily-log：按需渲染等价性
