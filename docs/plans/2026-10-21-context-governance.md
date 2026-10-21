# 上下文治理改造 · 修改清单（两轮 grill-me 拷问后修订版）

- 日期：2026-10-21
- 来源：invisible_dots 多轮对话管理学习 + grill-me 拷问
- 状态：待实施（先评审本清单，再动代码）；已过两轮 grill-me 拷问，第二轮新增风险见 §9
- 关联文档：`F:\allProject\githubProject\invisible_dots\多轮对话管理学习清单.md`

## 0. 背景与目标

invisible_dots（单 agent）对“记忆”自信的根因不是更聪明的长期记忆，而是：

1. 一条**只追加、不删除**的 transcript 是唯一事实来源；
2. 每轮无条件把「system + 摘要 + 最近历史 + 当前消息」重新拼进 prompt；
3. 超窗时两级压缩：先免费清理旧 tool result，再 LLM 摘要，并带**机械兜底**；
4. 摘要之后**永远保留最近 user 原文**（`min(20000, promptBudget/4)` token）；
5. token 预算来自 provider 的**真实窗口**（每轮读），而非固定字符阈值；
6. 长期记忆只靠「MEMORY.md 常驻 + 按天落盘的对话文件让模型自己 grep」。

本清单把上述经验移植进 blh，同时**保留 blh 已有优势**（事件溯源 + 回滚、多 agent、LLM 记忆召回 + keyword 兜底）。改动大不避讳，但拆成 **S0→S3 四个可独立合入、可独立回滚的切片**。

## 1. grill-me 拷问后修正的关键认知（原草案硬伤）

| # | 原草案假设 | 实际（已核对源码） | 修正 |
|---|---|---|---|
| 1 | 新建 `src/contracts/tokens.ts`，系数“字符/4” | `src/contracts/estimate.ts` **已存在**，`CHARS_PER_TOKEN = 3.5`，含 `estimateTextTokens / estimateMessageTokens / estimateContextTokens`，且**零调用方（死代码）** | 复用并升级 `estimate.ts`，不新建 |
| 2 | 需要改造 provider 接口传 maxTokens | `ChatProvider.chat / stream / chatWithUsage` 已带 `maxTokens?`；`loop.ts` 三处调用（约 502 / 531 / 533 行）传的是 `undefined` | 只需在 loop 计算并传入，provider 接口不动 |
| 3 | “新增：压缩后保留最近 user 原话” | `transcript.ts` 的 `isKeptAfterCompaction` 已是 `role === "user" 一律保留`（**全部** user 永不压缩） | 真实缺口是**给 user 保留加 token 上限**，否则贴 100KB 代码时压缩压不动 |
| 4 | 摘要挪进 system prompt = “挪一下” | `Transcript.compact` 首行 `if (role === "system") throw`；system 不进事件日志（`setSystem` 只改内存）；`SessionEvent.compaction` 用 `message: ChatMessage` 存摘要 | 完整版 = **事件 schema 迁移**，风险最大，单独立项 |
| 5 | “同步更新既有测试” | `test/runtime/loop.test.ts` 有 4 个用例直接断言 `[已压缩] / [响应式压缩] / 当前用户请求： / user 保留`，会被 S2 精确打破 | 列入测试影响清单，S2 一起改 |
| 6 | token 估算 = 字符/4 + 保守系数 | invisible_dots 真正的秘密是 `UNCOUNTED_RATIO = 1.35` + `PromptCounts.observe()` 用**端点真实 usage** 逐模型校准比例 | blh 的 `ChatUsage.promptTokens` 已在 loop 拿到，比它更有条件校准 |
| 7 | 只加 `contextWindow` 就能算 answerLimit | blh 无“每模型 max output tokens”字段：Anthropic 写死 `DEFAULT_MAX_TOKENS = 8192`，openai-compat 不传 | 需同时加 `maxOutputTokens?` |
| 8 | （无） | `moonshot-v1-8k`（8k）当前对 50000 字符阈值**一直超窗、靠 API 报错→reactiveCompact 救急** | 改窗口预算后是行为剧变，要写进验收 |
| 9 | 删孤儿 tool result 优先 | blh 用官方 SDK，call id 由服务端生成，不会复用 `call_0`；真实事故是**工具执行中崩溃→恢复后有 call 无 result** | `backfillMissingToolResults` 优先级高于 `dropOrphanToolResults` |
| 10 | C6 落点随意 | blh 已有 `MemoryStore / Extractor / Dream / Recall`，C6 归属不清会打架 | 定死 `.sessions/chat/`，与 memory 完全独立 |
| 11 | （无） | blh 是多 agent（`src/agents/`），子 agent 各持 provider | 预算元数据只读、无共享可变状态 |

## 2. 修订版方案（按依赖排序，每切片可独立合入/回滚）

### S0 · token 估算与窗口元数据（纯新增，无行为变化）

| 改动 | 文件落点 | 验收标准 |
|---|---|---|
| 在现有 `estimate.ts` 加 `estimatePromptTokens(messages, tools)`；引入 `UNCOUNTED_RATIO = 1.35`，并从 `ChatUsage.promptTokens` 逐模型校准比例（取历史最大，单调不减） | `src/contracts/estimate.ts` | 空输入=0；对同一输入 `estimate × max(1.35, learnedRatio)` 恒 ≥ 原始 estimate；learned ratio 单调不减（vitest） |
| `ProviderDefinition` 加 `contextWindow?`、`maxOutputTokens?`；catalog 给 4 个内置填值（数值**待按官方文档核实**：deepseek-chat 64k/8k、claude-sonnet-4-5 200k/64k、qwen-max 128k/32k、moonshot-v1-8k 8k/4k） | `src/contracts/types.ts`、`src/providers/catalog.ts` | 每个内置 provider 都有窗口值（vitest 遍历断言）；未知 provider 走保守默认（建议 8k）不抛错 |
| `resolveContextWindow(provider, model)` 支持 config/env 覆盖 + 保守默认 | `src/providers/catalog.ts` 或新文件 | config 覆盖优先于内置；非法值（≤0）回退默认 |

### S1 · 窗口预算接入 loop + 摘要 raw 兜底（核心行为变化）

> **作用域（2026-10-21 拍板）**：本次只做主 agent。子 agent / 队友 / workflow 的压缩另行立项（R1/R2）；`answerLimit` 在 loop.ts 计算，对所有走 loop 的调用方（含子 agent / 队友）都生效。

| 改动 | 文件落点 | 验收标准 |
|---|---|---|
| loop.ts 每请求算 `promptBudget = window - answerRoom - 1024`、`answerLimit = min(maxOutputTokens, window - promptTokens - 1024)`，把 `maxTokens` 传给 **stream / chat / chatWithUsage 三条路径**（当前都传 undefined） | `src/runtime/loop.ts` | MockProvider 断言收到的 maxTokens 是计算值而非 undefined；对 8k 窗口模型，超窗请求在**发请求前**就触发 prepare，不发请求 |
| `compactor.prepare` 阈值从 `contextCharLimit`（字符）切换为 token 预算；本地分层（toolResultBudget / microCompact / fitToolResults）阈值同步换 token | `src/compaction/compactor.ts` | 现有 compactor.test 改为 token 语义；`contextCharLimit` 保留为向后兼容别名或删除 |
| `summarizeHistory` 失败（抛错/空/tool_calls）返回确定性 `[RAW] N messages` 文本，不再 `(空摘要)` | `src/compaction/compactor.ts` | 失败返回内容含 `[RAW]` 与消息条数；方法保持可 override（现有测试不破） |

### S2 · user 保留预算 + 摘要语义最小化（P1）

| 改动 | 文件落点 | 验收标准 |
|---|---|---|
| user 消息保留改为预算制：`min(20000, promptBudget/4)`，从后往前累加，超出的旧 user 原文不再自动保留（进摘要/归档） | `src/session/transcript.ts`（`isKeptAfterCompaction` 加预算参数）、`src/compaction/compactor.ts`、`src/runtime/ports.ts` | 大段 user 粘贴后压缩，context 实际缩小；最近一条覆盖性指令原文仍保留；更新 `compact 工具在批次闭合后压缩` 等被打破的测试 |
| 摘要消息去掉 `当前用户请求：...` 一行（user 原文已保留），保留 `isCompactionSummary` 前端折叠语义 | `src/compaction/compactor.ts` | 摘要内容不再重复 activeRequest；折叠条仍渲染 |

### S3 · replay 清洗 + 每日对话落盘（P1/P2）

| 改动 | 文件落点 | 验收标准 |
|---|---|---|
| 新增 `sanitizeReplay(messages)`：`backfillMissingToolResults`（必须）+ `dropOrphanToolResults` / `stripMalformedToolCalls`（防御性）。**纯读侧转换（R5 已拍板）**：仅在压缩决策 / `compactTranscript` 之后作用于发送载荷 `modelMessages`，**不回写 transcript、不参与 `firstKeptIndex` 下标映射** | 新文件 `src/compaction/sanitize.ts`，`src/runtime/loop.ts` 接线 | 纯函数、不修改入参；幂等；补出的结果通过 `assertNoOrphanToolResults`；不误删合法配对；transcript 事件与投影不受影响 |
| 每轮收尾把 transcript 渲染追加到 `.sessions/chat/YYYY-MM-DD.md` | 新文件 `src/session/daily-log.ts`，`src/runtime/harness.ts` 接线 | 文件按本地日期命名；同一天多次运行是追加；与 memory 系统完全独立 |

## 3. C4 · 摘要进 system prompt —— 单独立项、暂缓

- 完整版改动点：`SessionEvent.compaction` 扩展 `summary` 字段/新增投影 slot、`PreparedContext` 加 `systemSummary`、`Transcript` 去掉 system 断言、`--continue` 事件版本迁移、前端折叠条改由显式 UI 事件驱动。
- **建议**：S0→S3 稳定前不动；先做 S2 的最小语义修正（去重复 user 请求）即可覆盖 80% 收益。
- 立项时独立评审，单独一份计划文档。

## 4. 明确不做的范围

- 不引入 tiktoken 依赖：用 chars/3.5 基础估算 + 1.35 系数 + 真实 usage 校准替代。
- 不做向量检索/embedding 记忆：blh 的 `MemoryRecall` 已优于 invisible_dots，不退回。
- 不改 v0 legacy 裸消息格式：`SessionStore.loadSession` 只读兼容保持，不迁移旧文件。
- 不做摘要的摘要链（多级 summary 合并）：单层摘要 + raw 兜底足够。
- 不做前端折叠条复杂 UI：C4 若做，只保“更早对话已压缩”一行提示的等价表达。

## 5. 执行顺序与依赖

```
S0（元数据 + 估算，纯新增）
 └─> S1（接线预算 + raw 兜底，核心行为变化）
      └─> S2（user 预算 + 摘要去重）
           └─> S3（清洗 + 日文件）
                 └─> C4 完整版（单独评审）
```

- S0/S3 与 S1/S2 可并行一部分，但 S1 依赖 S0 的窗口元数据。
- 每切片完成即 `pnpm test` + `pnpm lint` 全绿后再进入下一片。

## 6. 测试影响清单

| 切片 | 受影响测试 | 处理 |
|---|---|---|
| S0 | `test/providers/catalog.test.ts`（新增字段断言） | 补断言：内置 provider 均有窗口值 |
| S1 | `test/compaction/compactor.test.ts`（阈值语义） | 改 token 语义；补“8k 窗口发请求前触发 prepare”用例 |
| S1 | `test/runtime/loop.test.ts`（maxTokens 传 undefined 的断言，如有） | 补 MockProvider 断言 maxTokens 为计算值 |
| S2 | `test/runtime/loop.test.ts`（4 个断言：`[已压缩]/[响应式压缩]/当前用户请求：/user 保留`） | 随语义更新 |
| S2 | `test/session/transcript.test.ts`（compaction 投影） | 补“user 预算上限”用例 |
| S3 | 新增 `test/compaction/sanitize.test.ts` | 幂等 + 不误删 + backfill |

## 7. 风险清单

| 项 | 风险 | 缓解 |
|---|---|---|
| C4 完整版 | 高（事件 schema + `--continue` 迁移 + 前端渲染 + 4 测试） | 拆出独立 milestone，先做最小语义修正 |
| S2 | 中高（改 user 保留语义，波及三条压缩路径 + 测试） | 与 C4 去重一起设计，预算参数集中一处 |
| S1 的 answerLimit | 中（缺 maxOutputTokens 会引入新截断风险） | 先落 `maxOutputTokens` 元数据，否则只做 promptBudget 不做 answerLimit |
| S3 清洗 | 中（误删合法消息→回放不等价） | `assertNoOrphanToolResults` + 幂等测试兜住 |
| S0 窗口数值 | 低（官方文档可能变动） | 实现前逐个核实；未知回退 8k 保守默认 |
| S0/S1/S3 | 低 | 先行，独立合入 |

## 8. 首刀建议

若只先动一件事：**S1 的“把已有 maxTokens 管道真正接线 + 摘要 raw 兜底”**——复用现有代码、不碰事件 schema，收益（8k 模型不再靠撞错救急、摘要失败不再丢历史）立竿见影。

---

## 9. 第二轮 grill-me 复查：新识别的风险与补丁

> 第一轮拷问后落盘，又用 grill-me 做了第二遍（重点读 `src/agents/`、`src/jobs/`、`src/workflow/`、`src/runtime/harness.ts`、`scripts/swebench-run.ts`）。以下 R1–R10 是第一轮漏掉的，且 **R1 / R5 是动代码前必须先拍板的两处**。每条已逐条回核源码。

### 新识别风险

| # | 风险 | 触发场景 | 影响 | 补到 |
|---|---|---|---|---|
| R1 | **子 agent / 队友没有 compactor**：`src/agents/subagent.ts:43` 与 `src/agents/teammate.ts:443` 构造 `AgentLoopRuntime` 时都没传 `compactor`；loop 的 prepare/reactive 都包在 `if (compactor)` 里 | 主 agent 用 `task` 派子 agent、`spawn_teammate` 派队友，在 8k 模型上跑长任务 | 子 agent/队友既不主动压缩也不 reactive 重试，超窗直接 throw；队友把 error 发回 lead 就停 | S1 加“作用域” |
| R2 | **workflow 绕开 loop**：`src/workflow/runtime.ts:73` 用 `provider.chatCompletion`（无 tools、无 maxTokens、不经过 loop） | 主 agent 调 workflow 工具做多阶段编排，中间结果增长 | 预算/压缩对 workflow 不可见，prompt 可无限增长；usage 校准与主 agent 混同一池 | S0/S1 加“作用域” |
| R3 | **answerLimit 被压过小会截断工具调用/思考**：loop 在 stream/非流式 done 后**从不校验 finish_reason/stop_reason** | openai-compat 的 `max_tokens` 截断发生在 tool_call 参数拼接中途；anthropic 返回 `stop_reason:"max_tokens"` | 截断的 arguments 被 `parseToolArguments` 兜成 `{}`，工具以空参执行（危险）；或产出半句话 assistant | S1 加 answerLimit 下限 + finish_reason 校验 |
| R4 | **S2 把预算注入投影后，事件溯源投影变“模型相关”**：预算不落在事件里；`rollbackTo` 走 `projectEvents`、`compact` 走增量，参数不一致即分歧 | `--continue` 恢复、换模型、部署后重放旧 compaction 事件 | 同一事件日志在不同模型/版本下投影出不同上下文，破坏“唯一事实来源”确定性 | S2 加“投影确定性” |
| R5 | **S3 sanitize 插入/删除会破坏 `firstKeptIndex` 下标映射（硬 bug）**：`reactiveCompact` 的 `firstKeptIndex = tailStart` 是输入数组下标，loop 用 `messageSeqAt(index)` 映射回 transcript 投影 | 工具执行中崩溃恢复（恰是 backfill 要修的场景）+ 随后一次 reactiveCompact | 下标错位 → 保留错段或越界抛 `Message index out of range` | S3 重写下标语义 |
| R6 | **daily-log 四隐患**：敏感信息泄露、无界增长、cron/dream/team 回合入口漏写、dream 回滚后留脏记录 | bash 输出 / read_file 读到 .env/密钥；`runDreamTurn` 失败会 `rollbackTo` | 泄露 + 磁盘膨胀 + 日志与实际 transcript 不一致 | S3 明确范围/上限/入口/回滚 |
| R7 | **预算漏算 system 与 tools**：loop 现在 `prepare(transcript.conversation)` 只拿纯对话 | memory recall 注入大段、extensions 注入大 system 片段、小窗口模型 | promptBudget/answerLimit 被高估，撞错救急仍在（且自以为算对了） | S1 明确算完整载荷 |
| R8 | **S0 校准状态与自定义 provider**：主 agent/队友/子 agent/workflow 共享同一 provider，teammates 并发跑；`registerProvider` 可注册无窗口字段的自定义 provider | 并发 `observe()`；自定义 provider 落 undefined 分支 | 单线程单调 max 安全，但一旦持久化校准就跨进程竞态；undefined 参与运算得 NaN | S0 限定状态语义 |
| R9 | **S1 测试可行性**：流式 provider 不记录 maxTokens；“8k 发请求前触发 prepare”无法用“provider 抛错”来断言 | 测试用 MockProvider 三条路径 | 验收写出来执行不了，或靠 mock 巧合通过 | S1 测试影响清单 |
| R10 | **性能：估算重复计算**（低） | prepare 每步（toolResultBudget→snip→micro→fit）各算一遍 | 超长 tool result 下多几次全量扫描 | S1 性能注记 |

### 清单必须打的 5 个补丁（合并前）

1. **S1 加“作用域”**：明确子 agent / 队友 / workflow 是否纳入压缩（R1、R2）；预算函数接收**实际发送的完整载荷**（system + conversation + tools），而非 `conversation`（R7）。
2. **S1 加 answerLimit 下限 + finish_reason 校验**：`answerLimit` 低于阈值先压缩再发、不发 `max_tokens=1`；done 后校验 length/max_tokens，命中按 prompt-too-long 走 reactive 或至少不 append 截断的 tool_call（R3）。
3. **S2 加“投影确定性”**：预算参数单一入口，增量与全量重放共用同一函数；写死 `--continue` / rollback 的重放语义（R4）。
4. **S3 重写 sanitize 下标语义**：sanitize 要么只原位改内容不插入不删除，要么 `firstKeptIndex` 改为 seq 表达，要么 sanitize 只作用于发送载荷、在 compaction 计划生成之后（R5）；同时明确 daily-log 的记录范围/上限/四个 turn 入口/回滚后不写脏记录（R6）。
5. **S0 限定校准状态**：进程内、按 model 键、单调 max、**不持久化**（持久化另立议题）；`resolveContextWindow` 对 undefined（含自定义 provider）一律保守默认；vitest 只断言 builtin 有值，不断言所有 provider（R8）。

### 拍板记录（2026-10-21）

- **R5（已拍板：改）**：sanitize 定为**纯读侧转换**——只在压缩决策与 `compactTranscript` 之后作用于发送载荷 `modelMessages`，不回写 transcript、不参与 `firstKeptIndex` / `messageSeqAt` 下标映射；backfill 补出的合成 tool result 只进当次 provider 载荷，永不作为事件落盘。
- **R1（已拍板：本次只做主 agent）**：压缩（prepare / reactive）只注入主 agent；子 agent / 队友 / workflow 的压缩另行立项；`answerLimit` 仍在 loop.ts 计算，对所有走 loop 的调用方生效。

---

## 10. S1 后续重构：统一 token 度量（2026-10-21 拍板）

> S1 落地后 review 发现三个逻辑瑕疵：① 压缩管线 char/token 双轨并用（顶层 gate 用 token，本地分层用 char，靠 `budgetTokens × CHARS_PER_TOKEN` 桥接）；② 阈值是可变实例字段（`contextCharLimit`/`contextTokenLimit`），状态可跨调用残留；③ `prepare` 的 gate 用原始估算、loop 的 `answerLimit` 用校准后的估算，两者不同源，接近预算时真实 token 仍可能越界。本次重构收敛为一套设计。

### 决策

1. **全链路统一 token 度量**
   - 删掉 `estimateChars` 作为上下文尺寸度量；`prepare` gate、`microCompact`、`fitToolResults`、`toolResultBudget` 全部改用 `estimateContextTokens` / `estimateTextTokens`。
   - 删除 `budgetTokens × CHARS_PER_TOKEN` 桥接 hack。
   - 常量 token 化：`TOOL_RESULT_BATCH_CHAR_LIMIT → TOOL_RESULT_BATCH_TOKEN_LIMIT`、`LARGE_RESULT_CHAR_LIMIT → LARGE_RESULT_TOKEN_LIMIT`；删除 `CONTEXT_CHAR_LIMIT`。
   - 保留字符语义的仅剩「文本裁剪/块大小」类：`SUMMARY_INPUT_CHAR_LIMIT`（摘要输入 head/tail 裁剪）、`content.length <= 120`（太短不值得落盘）、`snipCompact` 的消息条数（另一轴）。

2. **阈值参数化、去可变状态**
   - 删除 `contextCharLimit`、`contextTokenLimit` 两个实例字段。
   - `prepare(messages, activeRequest, budgetTokens: number)`：预算**必传**，compactor 对阈值无状态。

3. **校准同源（修复隐藏 bug）**
   - compactor 只用原始估算 `estimateContextTokens`（model-agnostic）。
   - loop 传「原始估算尺度的预算」`budgetForCompactor = floor(promptBudget / tokenEstimator.ratio(model))`，`answerLimit` 用 `tokenEstimator.scale(model, rawPrompt)`。
   - 两者统一于 `raw × ratio ≤ promptBudget`，gate 与 answerLimit 同源。

### 文件落点与验收

| 改动 | 文件 | 验收 |
|---|---|---|
| 删 `estimateChars`、`CONTEXT_CHAR_LIMIT`；常量 token 化；`prepare` 预算必传并全 token；micro/fit/toolResultBudget 改 token | `src/compaction/compactor.ts`、`src/runtime/ports.ts`（prepare 签名） | 全仓无 `estimateChars`/`contextCharLimit`/`contextTokenLimit`/`CHARS_PER_TOKEN` 残留引用；compactor 无阈值可变状态 |
| loop 传 raw 尺度预算 + answerLimit 同源 | `src/runtime/loop.ts` | 8k 窗口下 gate 与 answerLimit 一致；现有 maxTokens/压缩测试绿 |
| 测试同步 token 语义 | `test/compaction/compactor.test.ts`、`test/runtime/loop.test.ts` | `pnpm test` + `pnpm lint` 全绿 |

---

## 11. C4 · 摘要进 system prompt（独立立项，待评审）

> S0–S3 已落地。C4 是最后一项：把压缩摘要从「user 消息（isCompactionSummary）」挪进 system prompt 的 `[Archived Context Summary]` 段，避免模型把摘要当新指令、避免污染 user-turn 边界。前端折叠条保留。

### 现状（C4 要改的点）

- `SessionEvent.compaction` 用 `message: ChatMessage` 存摘要（一个带 `isCompactionSummary` 的 user 消息），投影进对话。
- `Transcript` 的 system 单独持有、不进事件日志（`setSystem` 只改内存）。
- loop 的模型载荷 = `withSystem(conversation, transcript.systemMessage)`。
- 前端 `groupMessages` 靠 `isCompactionSummary` user 消息渲染折叠条（checkpoint block）。

### 设计草案（待 grill）

1. **事件 schema**：`SessionEvent.compaction` 的 `message: ChatMessage` 改为 `summary: string`（纯文本）。旧事件（有 `message`）读取时兼容：`summary = event.summary ?? (event.message?.content ?? "")`。
2. **投影**：compaction 不再把摘要 push 进 projected；改为单独记录 `latestSummary`。`projectEvents` 返回 `{ projected, summary }`。
3. **Transcript**：新增 `summaryText: string | null`；`messages`/`conversation` 不含摘要；`messagesWithIds`（display 视图）仍放一个 checkpoint 标记供前端折叠条。
4. **模型载荷**：loop 构造 system 时把 `transcript.summaryText` 拼成 `[Archived Context Summary]\n\n...` 段追加到 system 内容尾部（compaction 发生在轮中，故每请求现算，不依赖 setSystem）。
5. **前端**：`messagesWithIds` 的 checkpoint 标记保持 `isCompactionSummary`，`groupMessages` 基本不变。
6. **迁移**：`--continue` 读旧事件时把 `message.content` 当 summary，无需改 `SessionStore`（透传字段）。

### 风险（待 grill 细化）

- 事件 schema 变化 + 旧会话 `--continue` 迁移。
- system 与摘要的组合时机（轮中 compaction 后下一请求要带最新摘要）。
- 前端 display 视图与模型视图分叉，可能引入两套真相。

### grill 结论与决策（2026-10-21）

grill 指出 §11 把手段（事件 schema 迁移）当成了目标。**C4 的真实目标只取决于发给 provider 的载荷**，而摘要现在恒在 projected 最前、且至多一条，因此：

- **采纳 C4a（已实施）**：`loop.ts` 新增 `relocateCompactionSummary`，在唯一汇聚点（sanitizeReplay 之前）把 `isCompactionSummary` 的 user 消息抽到 system 的 `[Archived Context Summary]` 段。零迁移、零回归，transcript/compactor/store/前端零改动。
- **C4b（内部一致性清洗）暂缓**：若未来要「事件里不再有假 user 摘要」，必须同时补 grill 识别出的五个硬伤：连续压缩丢前序摘要（F2）、预算 gate 被摘要骗过（F3）、checkpoint 两套真相与 API 不一致（F5）、rollback 后摘要错位（F9）、`web-server/types.ts` 的 `SessionEventLike` 缺字段（F7）。单独立项。
- **明确不做**：`summary:string` 改名、摘要 JSON 去包装、把 summary 传给 memory recall（F10 有需求再定）。