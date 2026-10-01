# 多智能体评测体系设计

- 日期：2026-09-22
- 状态：待审查

## 1. 背景与目标

项目已有 50+ 单元测试和 `MockProvider` 脚本化假模型，但缺少「agent 行为级评测」——即给 agent 一个任务，看它最终有没有正确完成，而不是只测单个函数。

本次新增一套评测体系，首要评测对象是**多智能体协作**（blh 最亮眼的差异化能力）。借鉴 waku-agent 的「声明式题库 + 唯一打分器」设计，支持两条运行时路径：

- **离线**：用脚本化假模型回放，免费、快、可重复、可进 CI，验证框架逻辑与打分逻辑。
- **真实**：用 DeepSeek 真实跑，测真实协作能力，可选接 LLM judge 打质量分。

判定方式为**确定性打分 + LLM judge 并存**，两者独立、不合并。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 首要评测对象 | 多智能体协作（spawn_teammate / 任务认领 / 并行 / 结果回流） |
| 运行时 | 两者都要：离线假模型 + 真实模型 |
| 判定方式 | 确定性打分（checkCase）+ LLM judge（真实跑分时启用） |
| 离线 mock 路由 | 用 system 消息里的 `你是 '名字'` 识别 agent（不侵入核心代码） |
| judge 裁判模型 | 独立 provider 配置，通过 `EVAL_JUDGE_*` 环境变量单独指定 |

## 3. 目录与架构

```
evals/
  multiagent.jsonl          # 声明式题库（只写期望，不写脚本）
  fixtures/<id>.ts          # 离线脚本（lead + 各队友的假响应序列）
  check.ts                  # 唯一确定性打分器 checkCase
  mock.ts                   # 多角色脚本化 provider（MultiRoleMockProvider）
  judge.ts                  # LLM-as-judge（可选，真实跑分时启用）
  run.ts                    # CLI 入口，跑题库出 markdown 报告
  report.ts                 # 报告渲染
```

数据流：`run.ts` 读题库 → 对每个用例，离线走 `mock.ts`、真实走 `buildHarness` + DeepSeek → 跑完收集「上下文快照」（lead 工具调用 + 任务状态 + 产物文件）→ `check.ts` 确定性打分 → 真实模式再走 `judge.ts` 打分 → `report.ts` 汇总。

## 4. 题库 schema（`multiagent.jsonl`）

每行一条，纯声明，不含脚本：

```json
{
  "id": "parallel-fib-reverse",
  "input": "帮我并行实现 fib 和 reverse 两个函数，分别放到 demo/fib.ts 和 demo/reverse.ts",
  "expect_tools": ["create_task", "spawn_teammate"],
  "expect_min_tool_calls": { "spawn_teammate": 2 },
  "expect_tasks_completed": 2,
  "expect_files": [
    { "path": "demo/fib.ts", "contains": "fib" },
    { "path": "demo/reverse.ts", "contains": "reverse" }
  ]
}
```

字段说明：

| 字段 | 必填 | 含义 |
|------|------|------|
| `id` | 是 | 用例唯一标识，对应 `fixtures/<id>.ts` |
| `input` | 是 | 喂给 lead 的用户指令 |
| `expect_tools` | 否 | 必须在 lead 的 tool_calls 里出现的工具名 |
| `expect_min_tool_calls` | 否 | 某工具的最少调用次数（抓「只派一个队友就停」的精度问题） |
| `expect_tasks_completed` | 否 | TaskStore 里 `completed` 任务的最少数量 |
| `expect_files` | 否 | 必须落地的产物文件（`path` + 可选 `contains` 内容子串） |

## 5. 打分器 `checkCase`（`check.ts`）

因为多智能体是异步的，光看工具调用不够，判定分两个维度：

- **工具调用维**：`expect_tools` 每个都出现在 lead 的 tool_calls 里；`expect_min_tool_calls` 次数达标。
- **最终状态维**：`expect_tasks_completed`（TaskStore 里 completed 数）、`expect_files`（文件落地 + 内容子串）。

返回结构化结果：

```ts
interface CheckResult {
  passed: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
}
```

每个 check 有明确的通过/失败原因，报告里能逐条看到「哪一步没达标」。

## 6. 多角色离线 mock（`mock.ts`）

`ChatProvider.chat()` 接口不带 agent 标识，且 lead / 队友共用同一个 provider 实例（`team.ts` 的 `spawnTeammate` 把 `this.provider` 传给每个 `TeammateRuntime`）。为不侵入核心代码，用 **system 消息路由**：

- `MultiRoleMockProvider` 持有一个 `Map<string, ChatMessage[]>`（`"lead"` + 各队友名 → 各自脚本）。
- `chat(messages, tools, ...)` 里扫第一条 system 消息，用正则 `/你是 '([^']+)'/` 匹配队友名并路由到对应队列；匹配不到按 lead 处理。
- 每个角色自己的队列 `shift()`，耗尽时抛错并带上「哪个角色脚本耗尽」。

依据：队友的 system 消息确实以 `你是 '${name}'，一名 ${role}` 开头（`teammate.ts` 构造器），lead 的 system 消息是 harness 注入的（含 `create_task` / `spawn_teammate` 指令），两者可区分。

fixture 文件 `evals/fixtures/<id>.ts` 的导出约定（与 `MockProvider` 一致，复用 `makeToolCallMessage` / `makeTextMessage`）：

```ts
import type { ChatMessage } from "../../src/core/types.js";
import { makeToolCallMessage, makeTextMessage } from "../../test/integration/helpers.js";

export const lead: ChatMessage[] = [
  // lead 的响应序列（create_task → spawn_teammate → 结束本轮）
];

export const teammates: Record<string, ChatMessage[]> = {
  "fib-dev": [
    // fib-dev 的响应序列（write_file → complete_task → 结果汇报）
  ],
  "reverse-dev": [
    // reverse-dev 的响应序列
  ],
};
```

`MultiRoleMockProvider` 由 `run.ts` 根据用例 `id` 动态 `import` 这个 fixture，组装成 `Map`（`"lead"` + 各队友名）。

## 7. 真实模型运行时

复用 `buildHarness` + DeepSeek：跑真实 lead 首轮，队友在后台异步完成（`spawnTeammate` 里 `void runtime.run()` fire-and-forget）。需要一个 `waitForQuiesce()` 辅助：轮询 `team.activeTeammates` 直到全部空闲/清空或超时（队友有 2000ms 空闲扫描间隔）。

## 8. LLM judge（`judge.ts`，可选）

真实跑分时启用，用**非参赛模型**当裁判。裁判 provider/model 通过独立环境变量配置：

```
EVAL_JUDGE_BASE_URL=...
EVAL_JUDGE_API_KEY=...
EVAL_JUDGE_MODEL=...
```

把 `checkCase` 的上下文（真实 tool_calls + 任务状态 + 产物文件）作为 ground truth 传入裁判，打 0-10 的协作质量分——对齐 waku 的「把实际动作传给裁判，防误判幻觉」。离线模式跳过 judge。

## 9. CLI 入口（`run.ts`）

```powershell
pnpm evals              # 离线跑全题库（默认，免费可重复、进 CI）
pnpm evals --live       # 真实模型 + judge
pnpm evals --id xxx     # 只跑单个用例
```

输出 markdown 报告：每个用例的 checks 逐条结果 + 通过率 + judge 分（真实模式）。

## 10. 错误处理

- 脚本耗尽 → 报「哪个角色脚本耗尽」。
- 队友超时 → 用例标记 `timeout`（不计通过）。
- 产物文件缺失 → check 里写「文件未落地」。
- judge 未配置却在 `--live` 下启用 → 明确报错提示先配 `EVAL_JUDGE_*`。

## 11. 测试策略

- `checkCase` 各分支单测（工具缺失 / 次数不足 / 任务未完成 / 文件缺失 / 全通过）。
- `MultiRoleMockProvider` 的路由单测（lead 路由、各队友路由、脚本耗尽报错）。
- 一个「gold 脚本全通过」的最小端到端离线用例，验证「题库 → mock → 打分 → 报告」全链路。

## 12. 变更文件清单

- 新增 `evals/multiagent.jsonl`（题库，先放 1~2 个用例）。
- 新增 `evals/fixtures/<id>.ts`（离线脚本）。
- 新增 `evals/check.ts`、`evals/mock.ts`、`evals/judge.ts`、`evals/report.ts`、`evals/run.ts`。
- 新增 `test/evals/check.test.ts`、`test/evals/mock.test.ts`、`test/evals/e2e.test.ts`。
- 修改 `package.json`：新增 `"evals": "tsx evals/run.ts"`。

## 13. 非目标（YAGNI）

- 不做单 agent 工具调用评测、coding（SWE-bench 风格）评测——作为后续扩展挂载。
- 不做跨模型 shootout 对比（先只跑当前配置的模型）。
- 不做网页竞技场（arena）。
- 不改核心 `src/` 代码（`ChatProvider` 接口等保持不动）。
- 不引入 Python / DeepEval 等跨语言依赖，纯 TypeScript 实现。
