# 2026-10-21 todo 提醒无界注入 + 回合失控

## Bug A：`<reminder>Update your todos.</reminder>` 被无界注入

- **日期**：2026-10-21
- **影响模块**：`src/planning/todo.ts`、`src/runtime/loop.ts`、`src/compaction/compactor.ts`
- **症状**：一次会话里 `<reminder>Update your todos.</reminder>` 作为 user 消息被注入 **13 次**，污染 session 日志和模型上下文。
- **证据**：`.sessions/session_*.jsonl` 中 `isInternal:true` 的 `<reminder>` 消息 13 条；trace 显示同一回合 `iterations=40`。

- **根因**：
  1. `TodoManager.noteRound` 是**纯计数器**（连续 3 轮没用 `todo_write` 就提醒），完全不检查 `this.items` 是否还有未完成项——todo 全 completed、甚至空列表，照样提醒。
  2. 提醒被 `loop.ts` append 成 `role:"user"` 的消息（`isInternal:true` 只隐藏 UI），但：
     - 写进 session 日志；
     - 进入模型上下文；
     - `ContextCompactor.userRetentionIndex` **没过滤 `isInternal`**，导致这些假 user 消息被当成「要保留的用户请求」参与压缩预算。

- **修复**：
  1. `noteRound` 只在**存在未完成项**时才计数提醒（`hasOpen` 守卫）。
  2. `userRetentionIndex` 跳过 `isInternal` 的 user 消息（只保留真实用户请求）。

- **回归测试**：
  - `test/planning/todo.test.ts`：空列表/全 completed 时 `noteRound` 恒返回 null。
  - `test/compaction/compactor.test.ts`：`userRetentionIndex` 跳过 isInternal。

- **教训**：
  1. 提醒/注入类机制必须**有条件**（状态确实需要提醒才提醒），不能是裸计数器。
  2. `isInternal` 消息要贯彻到所有「读 user 消息」的路径，否则「UI 隐藏」不等于「逻辑不参与」。

## Bug B：回合失控（40 轮 / 58 工具 / 174s 后才被 abort）

- **日期**：2026-10-21
- **影响模块**：`src/runtime/loop.ts`
- **症状**：一次「看下项目质量」请求跑出 `iterations=40, tools_used=58, latency≈3分钟`，最终靠用户手动 abort。
- **证据**：`.blh/traces/2026-10-21.jsonl` 中 `turn 2 ... iterations:40 tools_used:58 reason:"aborted"`。

- **根因**：
  1. `runAgentLoop` 的 `for(;;)` 唯一上限是 `profile.maxTurns`，但 harness 调 `agentLoop` 时传的 profile 是空对象 `{}` → `maxTurns` 为 `undefined` → **默认无上限**。
  2. 循环内没有「重复命令检测」和「无进展检测」——agent 连续重试同一命令（如那条编译崩溃的正则命令）毫无察觉。

- **修复**：
  1. **重复命令熔断**：追踪「连续相同的非后台 bash 命令 + 相同输出」，达到阈值（5 次）直接结束回合，状态记为 `stalled`（镜像 `max_turns` 的收尾：`endTurn("stalled")` + `turn_end` 事件）。
  2. **上限兜底**：`maxTurns` 默认值（`DEFAULT_MAX_TURNS`）作为最后防线，仍可被 `profile.maxTurns` 覆盖。

- **回归测试**：
  - `test/runtime/loop.test.ts`：脚本化 provider 连续返回相同 bash 命令 → 断言 `status === "stalled"`、`iterations === 5`；不同命令/不同输出不误伤（正常 completed）。

- **教训**：
  1. 「无限循环」类逻辑必须有**带信号的熔断**（重复/无进展），死板轮数上限会误伤合法长任务，但完全无上限会让 agent 原地打转。
  2. 熔断的触发信号要**可观测**（trace 记 `stalled`），否则用户只知道「又 abort 了」。
