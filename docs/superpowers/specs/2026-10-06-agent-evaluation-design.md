# 评测体系设计（v2）

- 日期：2026-10-06
- 状态：待审查（方案定稿，分七步实施）
- 取代：`2026-09-22-agent-evaluation-design.md`

## 1. 背景与目标

项目已有 605 个单元/集成测试和 `MockProvider` 脚本化假模型，但缺少「agent 行为级评测」——给 agent 一个任务，看它最终有没有正确完成，而不是只测单个函数。

本次新增一套评测体系。与 waku-agent 的 `evals/` 对照后，结论是：**waku 的评测体系其实是三层，blh 已经有一层（deterministic），缺的是「声明式题库层」和「LLM judge 层」**。因此本次不做重复的确定性测试，而是补上缺的两层，并复用现有 vitest 体系，不另起一个跑器。

## 2. 与 waku-agent 评测体系对照

| 层 | waku 的做法 | blh 现状 | 本次动作 |
|---|---|---|---|
| deterministic | `evals/deterministic/test_*.py`，`ScriptedClient` 假模型 + 隔离 home | 已有：`test/integration/agent.test.ts` + `test/integration/helpers.ts` 的 `MockProvider` | 复用，不再重做 |
| 声明式题库 | `evals/dataset.jsonl`（`expect_tool`/`expect_in_args`/`expect_min_tool_calls`）、`evals/coding.jsonl`（`verify` 命令，退出码=判分） | 缺 | **本次核心**：题库 + 唯一打分器 |
| LLM judge | `evals/judge/`，DeepEval `GEval` + 自定义 judge，`skipif(not HAS_KEY)`，0–1 分数 + 阈值 | 缺 | **第三步，opt-in**：改用 DeepEval 的 TypeScript SDK（同源库，vitest 原生） |

关键结论：waku 的 `deterministic` 本质就是 blh 现有 `MockProvider` 行为测试；blh 不是「没有评测体系」，而是「缺题库层 + judge 层」。

### 对照 pi 最新评测体系（`packages/evals`，基于 vitest-evals）

最新 pi 有一个独立评测包，值得借鉴的点（已拆入第四~六步）：

- **结构化输出判题**：逼 agent 调一个自定义工具（JSON schema 约束），把结论交成结构化数据，再确定性校验工具参数——比 LLM judge 便宜、稳定、可重复。（→ 第四步）
- **配对 A/B「lift」对比**：`control`（如 without_docs）vs `treatment`（with_docs），算 `lift = 通过率差`，并 flag `no-lift / negative-delta / saturated / flaky`。（→ 第五步）
- **重复 + 稳定性纪律**：多次重复、交替 variant 顺序消顺序偏差；「一次重复无法证明稳定性」；blocked pairs（数据不完整就 withhold 结论）。（→ 第六步）
- **运营指标 + 可复现**：每个 variant 统计 tokens/toolCalls/耗时/成本，落 protocol + 计划队列。（→ 第六步）
- **沙箱隔离**（Docker + 非特权 UID + 工具白名单）：真实跑分时 agent 会写任意代码，需隔离；blh 已有 worktree，可借思路做轻量隔离。（→ 第七步）

## 3. 核心决策

| 决策点 | 选择 | 说明 |
|---|---|---|
| 运行器 | **vitest，不另起 `tsx run.ts`** | 与现有 `pnpm test` 统一，CI 天然可接；markdown 报告做成可选脚本 |
| 起手对象 | **单 agent 声明式工具调用评测**（第一步） | 单 agent 几乎零新机器即可跑通「题库→打分→报告」骨架，先跑通骨架再逐步扩展 |
| 判定方式 | 确定性 `checkCase` + LLM judge 并存，**互不合并** | 沿用 waku 的原则：pass/fail 与质量分永远分开 |
| 参数校验 | 必须支持 `expect_in_args`（工具参数子串匹配） | waku 题库里最有用的字段；只数工具名/次数抓不住「派错了人」 |
| 文件校验 | `expect_files[].contains` 之外，加可选 `verify` 命令 | 退出码=判分，比子串更可靠 |
| judge 语义 | 0–1 分数 + 阈值，`skipIf` 无 key | 沿用 waku 的 `HAS_KEY` skip 语义 |
| judge 库 | **DeepEval TypeScript SDK（`deepeval` npm），不自研判分逻辑** | 与 waku 同源；vitest 原生；支持 DeepSeek 当裁判；判分/阈值/原因解释全部外包 |
| 判定顺序 | **确定性优先**：工具调用/参数/verify → 文件/任务 → 最后才 judge 打主观维 | judge 只打主观维，**永远不能覆盖确定性失败**（RubricLoop/Claw-Eval） |
| 可重跑 | **真实跑分 trace 落盘 + 离线重打分** | 换指标/阈值不必重跑 agent（dsh-eval/eval-harness）；复用 blh 现有 tracing |
| 结构化判题 | **优先「结构化工具 + 参数校验」判题，LLM judge 只兜底主观维** | 比 judge 便宜/稳定/可重复（pi 的 StructuredOutputJudge 思路）；blh 已有 `expect_in_args`，加一个 `submit_result` 工具即可 |
| A/B 对比 | **支持 variant（control/treatment）算 lift** | 测「去掉某子系统（memory/skills/workflow）通过率掉多少」，是子系统价值的证明 |
| 报告纪律 | **重复次数 + 交替顺序 + blocked pairs + flaky** | 数据不完整就 withhold 结论，不把缺失当 0 |
| 沙箱隔离 | **真实跑分用容器 + 非特权 + 工具白名单隔离 agent** | 保护评测源码/裁判不被 agent 篡改（pi 思路）；离线 mock 不需要 |

### 可接入性（贯穿各步骤的约束）

评测体系要能被「任何地方」调用，而不只是 vitest 用例：

- **打分器已可接入**：`checkCase` 是纯函数，`EvalCase`/`CaseContext` 是纯数据，任何代码都能 `checkCase(case, snapshot)`。
- **跑分器还不可复用（两个缺口）**：
  1. 「上下文收集」（transcript → toolCalls/files/finalOutput/safety）现在写在 `test/evals/cases.test.ts`，应抽成 `evals/collect.ts` 的 `collectContext(transcript, workdir, evalCase)`。
  2. `buildHarness` 内部写死 `createProvider(config)`，离线评测无法把 mock provider 注入真实 harness，只能手搓简化 harness（不完整、易漂移）。应给 `buildHarness` 加可选 `provider` 注入（向后兼容，默认仍 `createProvider`）。
- **改进后的接入形态**（vitest / CLI / live / CI / web 通用）：
  ```ts
  const harness = buildHarness(workdir, cli, askUser, skipPermissions, { provider: mockOrReal });
  const result = await runCase(harness, evalCase); // 跑 turn + collectContext + checkCase + 可选 judge
  ```
- **judge 已按「可接入」落地**：`evals/judge.ts` 用 DeepEval TS 的 `GEval` + `DeepSeekModel`，复用 `CaseContext`；结构化判题（第四步）可进一步减少对 judge 的依赖。

## 4. 目录与架构

```
evals/                          # 数据 + 纯逻辑（不依赖 vitest，可被 test 引用）
  cases.jsonl                   # 第一步：单 agent 声明式题库
  check.ts                      # 唯一确定性打分器 checkCase（纯逻辑，无 I/O）
  collect.ts                    # 上下文收集：transcript/workdir → CaseContext（可复用）
  submit-result.ts              # 第四步：结构化判题工具 submit_result
  plan.ts / lift.ts             # 第五步：A/B 消融（计划 + lift；Arm 类型在 lift.ts）
  judge.ts                      # 第三步：LLM judge（DeepEval 薄封装）
  report.ts                     # 第六步：markdown 报告渲染
  runner.ts / live-cli.ts       # 拼装：统一跑分 + 真实跑分 CLI
test/evals/                     # vitest 驱动，读题库逐条跑
  cases.test.ts                 # 离线跑单 agent 题库
  check.test.ts                 # checkCase 单测
  judge.test.ts                 # judge，skipIf 无 key
  ablation.test.ts              # A/B 消融单测 + 端到端演示
  report.test.ts                # 报告单测
  integration.test.ts           # provider 注入验证
```

实现细节：`tsconfig.json` 的 `include` 增加 `evals/**/*.ts`（保证 `pnpm typecheck` 覆盖打分器/报告），vitest 通过相对路径 `../../evals/*.ts` 直接引用。数据流：`*.test.ts` 读题库 → 每个用例离线走 `MockProvider`、真实走 `buildHarness` → 收集上下文快照（lead 工具调用 + 任务状态 + 产物文件）→ `check.ts` 确定性打分 → 真实模式再走 DeepEval（`judge.ts` 薄封装）打质量分 → 断言/报告。

## 5. 题库 schema（`cases.jsonl`）

每行一条，纯声明，不含脚本：

```json
{
  "id": "write-and-read",
  "input": "创建 hello.txt 写入 world 并读回",
  "expect_tools": ["write_file", "read_file"],
  "expect_in_args": { "write_file": { "path": "hello.txt" } },
  "expect_files": [{ "path": "hello.txt", "contains": "world" }],
  "verify": "grep -q world hello.txt"
}
```

字段说明：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | string | 是 | 唯一标识，对应离线 fixture（若用） |
| `input` | string | 是 | 喂给 lead 的用户指令 |
| `expect_tools` | string[] | 否 | 必须出现在 lead 的 tool_calls 里的工具名 |
| `expect_not_tools` | string[] | 否 | 不应出现在 tool_calls 里的工具名 |
| `expect_in_args` | `Record<tool, Record<arg, string>>` | 否 | 某工具的某参数必须包含该子串（不区分大小写） |
| `expect_min_tool_calls` | `Record<tool, number>` | 否 | 某工具的最少调用次数 |
| `expect_max_tool_calls` | `Record<tool, number>` | 否 | 某工具的最多调用次数（抓冗余/重复劳动） |
| `expect_tasks_completed` | number | 否 | TaskStore 里 `completed` 任务最少数量（任务类用例） |
| `expect_files` | `Array<{path, contains?}>` | 否 | 必须落地的文件 + 可选内容子串 |
| `expect_final_output` | string | 否 | 最终回复文本必须包含该子串（不区分大小写） |
| `expect_safe` | boolean | 否 | 为 true 时断言「没有执行任何危险命令」 |
| `verify` | string | 否 | 在 workdir 里执行的可执行命令，退出码 0 = 通过（比 `contains` 更强） |

## 6. 打分器 `checkCase`（`check.ts`）

判定分四个维度（纯逻辑，接收「上下文快照」，不直接读盘/读模型）：

- **工具调用维**：`expect_tools` 出现、`expect_not_tools` 不出现、`expect_in_args` 参数子串命中、`expect_min_tool_calls` / `expect_max_tool_calls` 次数上下限达标。
- **最终状态维**：`expect_tasks_completed`（TaskStore completed 数）、`expect_files`（文件落地 + 内容子串）、`expect_final_output`（最终回复子串）。
- **安全维**：`expect_safe` 断言「没有执行危险命令」（对 bash 调用做 `isDestructiveBashCommand` 扫描）。
- **可执行校验维**：`verify` 命令退出码为 0。

```ts
interface CheckResult {
  passed: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
}
```

每个 check 有明确的通过/失败原因，报告里能逐条看到「哪一步没达标」。

判定按**级联顺序**执行：先确定性（工具调用/参数/次数）→ 再 `verify` → 最后才用 LLM judge 兜底主观维；能确定性判定的绝不用 judge。

## 7. 离线 mock

- **离线（单 agent）**：直接复用 `test/integration/helpers.ts` 的 `MockProvider` / `makeToolCallMessage` / `makeTextMessage`，零新增。

## 8. 真实模型运行时

真实跑分用 `buildHarness`（真实 provider）+ `evals/runner.ts` 的 `runCase`，`pnpm eval:live` 即可跑 `cases.jsonl`；每次 run 走完整 harness（含 memory/goal），产物落在工作目录里，`collectContext` 再收集快照判分。

- **trace 落盘 + 离线重打分**：每次真实 run 把完整轨迹（会话事件 + 工具调用 + 任务状态 + usage）落盘为 `evals/traces/<id>.jsonl`（复用 blh 现有 `src/tracing/` 或 transcript 事件）；之后换指标/阈值只需离线 `re-score`，不必重跑 agent。

## 9. LLM judge（第三步，opt-in，外包给 DeepEval TypeScript SDK）

调研结论：**DeepEval 有 TypeScript SDK（`deepeval` npm，Apache-2.0）**，就是 waku 用的那个库的 TS 版——跑在 vitest 上，提供 `GEval`/`TaskCompletionMetric`/`AnswerRelevancyMetric` 等 LLM-as-judge 指标、`toPass()` 匹配器、0–1 分数 + 阈值 + 原因解释，并支持 OpenAI/Anthropic/DeepSeek/Kimi 及任意 OpenAI 兼容端点当裁判。因此本层**不自研判分逻辑**，只写一层薄封装 `judge.ts`：把 blh 的上下文（tool_calls + 任务状态 + 产物文件）映射成 `LLMTestCase`，并固定裁判模型与阈值。

- 裁判模型：用非参赛模型（默认 DeepSeek，`npx deepeval set-deepseek --model ...` 或给 metric 传 `model`），独立于被评模型。
- 语义：0–1 分数 + 阈值（如 0.6），**永远不和 `checkCase` 的 pass/fail 合并**。
- 门控：`judge.test.ts` 用 `describe.skipIf(!hasJudgeKey())`；未配 key 时跳过而不是报错。
- 取舍：TS 版比 Python 版晚、且 Synthesizer/Benchmarks/RAGAS 指标/Red teaming 仍是 Python-only——这些都不在本项目范围内；只用它的核心指标 + `toPass()`。
- 硬规则：judge 只打主观质量维，**不能把 `checkCase` 的确定性失败改判为通过**。
- 实践：按维度拆专门 judge（factual / task-completion / coordination），不要求一个 judge 评所有维；跨 run 固定同一裁判模型与参数；注意 position / verbosity / self-preference 偏差。

## 10. 报告（第六步）

`report.ts` 汇总跑分，遵循 pi 的纪律：

- 每个用例逐条 check 结果 + 通过率 + judge 分（真实模式）+ 运营指标（tokens/工具调用/耗时/成本）。
- **重复与稳定性**：真实跑分支持 `runs-per-variant`；重复时交替 variant 顺序消顺序偏差；标记 `flaky`。
- **blocked pairs**：A/B 对比里，任一 arm 缺失/重复/skip/error 则该 pair 不计入 lift，headline 通过率 withhold，不造假数字。
- 数据落 `.eval/`（可复现），不替代 vitest 断言，不参与 CI。

## 11. 分阶段实施计划（四步）

### 第一步：单 agent 声明式工具调用评测（本次先落地）

- **目标**：跑通「题库 → 打分 → 报告」最小骨架，覆盖 waku `dataset.jsonl` 的价值。
- **交付**：`evals/cases.jsonl`（先 3~5 个用例）、`evals/check.ts`、`test/evals/cases.test.ts`（读题库 + `MockProvider` + `checkCase`）。
- **题库原则**：优先从真实失败/真实任务里沉淀 20~50 个用例，少用合成边界用例；当通过率长期 >80~90% 时说明信号饱和，要换更难的题（Anthropic「Demystifying evals」）。
- **验收**：① 用例用现有 `MockProvider` 离线跑通；② `expect_tools`/`expect_in_args`/`expect_min_tool_calls`/`expect_files` 四维都能断言；③ 每条 check 有 pass/fail 与原因。

### 第二步：接进 CI

- **目标**：让评测成为 `pnpm test` 的一部分，不引入双跑器。
- **交付**：确认 `test/evals/*.test.ts` 被 vitest `include` 覆盖；`tsconfig.json` 加 `evals/**/*.ts`。
- **验收**：CI 离线跑全题库，无 key 不触发真实调用。

### 第三步：LLM judge（opt-in）

- **目标**：给真实跑分加质量分，与确定性分并存。
- **交付**：`evals/judge.ts`（薄封装，复用 blh `ChatProvider`，见「可接入性」）、`test/evals/judge.test.ts`（`skipIf` 无 key）；可选引入 `deepeval` devDependency。
- **验收**：无 key 跳过；有 key 时产出 0–1 分 + 阈值 + 原因，与 `checkCase` 不合并。

### 第四步：结构化输出判题

- **目标**：用「结构化工具 + 参数校验」替代大部分 LLM judge，更便宜、稳定、可重复（pi 的 StructuredOutputJudge 思路）。
- **交付**：评测用 `submit_result` 工具（JSON schema 约束结构化输出）+ `cases.jsonl` 加结构化用例 + `checkCase` 精确校验参数。
- **验收**：① 一个「agent 交结论」用例用结构化工具判题，不调 judge 也能判定；② `expect_in_args` 精确匹配 `submit_result` 的参数。

### 第五步：A/B ablation + lift

- **目标**：测「去掉某子系统（memory/skills/workflow/compaction）通过率掉多少」，给子系统价值定性（pi 的 control/treatment + lift）。
- **交付**：`evals/plan.ts`（case × variant × run 展开）+ `evals/lift.ts`（`Arm` 类型 + lift 计算）。
- **验收**：① 一个子系统能做 with/without 对比；② 输出 `lift` + `no-lift / negative-delta / saturated / flaky` flags。

### 第六步：报告层（重复 + blocked + flaky + 运营指标）

- **目标**：让真实跑分的结论可靠、可复现、可审计。
- **交付**：`evals/report.ts`（重复次数、顺序交替、blocked pairs、运营指标、`.eval/` 落盘）。
- **验收**：① 数据不完整时 withhold 结论（不把缺失当 0）；② 多次重复能标记 flaky；③ 输出 tokens/耗时/成本。

### 第七步：评测沙箱（真实跑分隔离）

- **目标**：真实跑分时 agent 会写任意代码、调工具，需隔离，保护评测源码、裁判和主机（pi 的沙箱思路）。
- **已实现（轻量沙箱）**：`evals/sandbox.ts` 的 `createSandboxHarness`——safe 策略去掉 `bash`（无 shell/网络），只留 read/write/edit/glob + `submit_result`；配合 blh `safePath`（文件只能读写 workdir 内）+ 每 run 独立 workdir，agent 读不到 judge/fixtures、不污染主机。
- **后续（按需，仅 coding 评测需要 bash 时）**：Docker 容器 + 非特权 UID + 评测源码 root-only（pi 的完整模型）。
- **验收**：① safe 下无 bash（读不到 judge/fixtures）；② 每 run 独立 workdir；③ `pnpm eval:live` 默认 safe，`--full-tools` 可放开 bash（失去沙箱保护）。

## 12. 测试策略

- `checkCase` 各分支单测（工具缺失 / 参数不命中 / 次数不足 / 任务未完成 / 文件缺失 / verify 失败 / 全通过）。
- 一个「gold 脚本全通过」的最小端到端离线用例，验证「题库 → mock → 打分」全链路。
- judge 用 `skipIf` 门控，不依赖真实 key。

## 13. 变更文件清单

- 新增 `evals/cases.jsonl`。
- 新增 `evals/check.ts`、`evals/collect.ts`、`evals/submit-result.ts`（第四步）、`evals/plan.ts` + `evals/lift.ts`（第五步）、`evals/judge.ts`（DeepEval 薄封装）、`evals/report.ts`（第六步）、`evals/runner.ts` + `evals/live-cli.ts`（拼装：统一跑分 + 真实跑分 CLI）。
- 新增 devDependency：`deepeval` + `@sentry/node`（`deepeval` 的 telemetry 间接依赖，缺失会导致 import 失败）。
- 新增 `test/evals/cases.test.ts`、`test/evals/check.test.ts`、`test/evals/judge.test.ts`、`test/evals/ablation.test.ts`、`test/evals/report.test.ts`、`test/evals/integration.test.ts`（provider 注入验证）。
- 修改 `tsconfig.json`：`include` 加 `evals/**/*.ts`。
- 修改 `package.json`：加 `"eval:live": "tsx evals/live-cli.ts"`。
- 第七步沙箱（未做）：新增 `evals/sandbox/`（或 `docker/`）。

## 14. 非目标（YAGNI）

- 不做 SWE-bench 风格 coding 评测、跨模型 shootout、网页竞技场。
- 核心 `src/` 代码尽量不改（仅 `buildHarness` 加了一处 `provider` 注入）。
- 不引入 Python 版 DeepEval / RAGAS 等跨语言依赖；judge 层用 DeepEval 的 TypeScript SDK，其余纯 TypeScript + vitest。
- `pass@k` / `pass^k`（非确定性度量）与基线回归（tracelens）作为后续可选，先不做。
## 15. 执行状态

- [x] 第一步：单 agent 声明式工具调用评测（`evals/check.ts` + `cases.jsonl` + `test/evals/cases.test.ts`）
- [x] 第二步：接进 CI（vitest include + tsconfig/eslint 覆盖 `evals/`）
- [x] 第三步：LLM judge（DeepEval TS，`evals/judge.ts` + `test/evals/judge.test.ts`，`skipIf` 无 key）
- [x] 可接入性重构：`evals/collect.ts`（`collectContext`）+ `buildHarness` 加 `provider` 注入
- [x] 第四步：结构化输出判题（`evals/submit-result.ts` + `expect_in_args` 精确校验）
- [x] 第五步：A/B ablation + lift（`evals/plan.ts` + `evals/lift.ts` + `test/evals/ablation.test.ts`）
- [x] 第六步：报告层（`evals/report.ts` 的 `summarize` + `renderReport` + `writeReport`；重复/顺序交替在第五步 plan.ts，blocked/flaky 在 lift.ts）
- [x] 拼装：`evals/runner.ts`（`runCase` 统一入口）+ `evals/live-cli.ts`（真实跑分 CLI，`pnpm eval:live`）
- [x] 第七步：评测沙箱（轻量版：`evals/sandbox.ts` 工具白名单 + 独立 workdir；Docker 隔离后续按需）