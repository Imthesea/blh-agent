# Web 前端中断功能设计

- 日期：2026-09-20
- 状态：待审查

## 1. 背景与目标

用户在浏览器 Web 界面与 AI 聊天时，AI 回复过程中无法主动中断，只能等它跑完。本次为 Web 前端新增「中断」能力：

- 用户点击「停止」后，**彻底中断**当前这一轮：停止模型生成、停止后续工具调用，并**强杀正在运行的 bash 命令**。
- 中断后，已生成的半成品文字**保留**，并带上「已中断」标记；已修改的文件/已跑完的命令不回滚。
- 审批等待期间不提供中断（审批时只能选允许/拒绝）。

范围仅限 Web 前端，CLI REPL 不在本次范围内。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 覆盖入口 | 仅 Web 前端 |
| 中断深度 | 彻底：停生成 + 停后续工具 + 强杀正在跑的 bash |
| 半成品处理 | 保留文字 + `cancelled` 字段标记（前端渲染「(已中断)」） |
| 审批等待时 | 不可中断 |
| 停止按钮 | `InputBar` 中「发送」按钮在可中断期间原地变成「停止」 |
| 信号机制 | `AbortSignal` 全链路贯穿（方案 A） |
| 后台任务 | `run_in_background` 的 bash 不在中断范围内 |

## 3. 中断信号流

```
用户点「停止」 → POST /api/stop
  → SessionManager.stop() → AbortController.abort()
  → signal 贯穿：
       · provider.chat / stream（OpenAI SDK 收到 signal 立即断流）
       · runBash（abort 时 killTree 强杀子进程树）
  → agentLoop 捕获中断 → 落盘半成品 → 广播 turn_cancelled
  → 前端固化 + refresh() 展示「(已中断)」
```

中断是**正常结束**：`agentLoop` 捕获中断后正常 `return`，不抛 `agent_error`，`withLock` 锁正常释放，后续可继续发消息。

## 4. 核心层改动

### 4.1 `src/core/types.ts`

- `ChatProvider.chat/stream` 签名增加可选 `signal?: AbortSignal`。
- `ToolHandler` 从 `(args) => Promise<string>` 改为 `(args, signal?) => Promise<string>`。
- `ChatMessage` 增加可选 `cancelled?: boolean`。

### 4.2 `src/core/events.ts`

`AgentEvent` 新增：

```ts
| { type: "turn_cancelled"; text: string }
```

`text` 为中断时已生成的半成品文字（可能为空串）。

### 4.3 `src/core/loop.ts`

- `agentLoop` 增加 `signal?: AbortSignal` 参数。
- 新增 `TurnCancelledError`（继承 `Error`，携带 `partialText`），用于区分「用户中断」与「真实错误」。
- `streamAssistantMessage` 接收 `signal`，流式生成期间被 abort 时抛出 `TurnCancelledError`（携带已累积文本）。
- 中断分两种时机，统一收敛为「广播 `turn_cancelled` + 按需落盘 + `return`」：

**时机 A：模型生成阶段被中断（流式/非流式调用中）**

- `streamAssistantMessage` 抛出 `TurnCancelledError(partialText)`。
- 捕获后：把半成品组装成 `{ role: "assistant", content: partialText, cancelled: true }`，追加进 `messages` 与 `sessionStore`，广播 `turn_cancelled(text: partialText)`，`return`。

**时机 B：工具执行完成后检测到中断**

- 在循环开头、以及每个工具执行完后检查 `signal.aborted`。
- 此时模型这条 assistant 消息（含 tool_calls 与已生成文字）与 tool 结果都已在 `messages`/`sessionStore` 中，无需再落盘半成品。
- 直接广播 `turn_cancelled(text: "")`，`return`。

### 4.4 `src/core/harness.ts`

`runTurn` 增加 `signal?: AbortSignal`，透传给 `agentLoop`。`runScheduledTurn` / `runTeamTurn` 不传 signal（后台/团队轮次不受 Web 中断影响）。

## 5. provider / tools 层改动

### 5.1 `src/providers/openai.ts`

- `ChatCompletionsClient.create` 的 options 增加 `signal?: AbortSignal`。
- `chat` / `stream` 接收 `signal`，透传给 OpenAI SDK 的 `create(params, { timeout, signal })`。

### 5.2 `src/tools/bash.ts`

- `runBash` 增加 `signal?: AbortSignal`。
- 传入 signal 时注册 `abort` 监听：触发时调用 `killTree(child)` 强杀进程树，并 resolve `"error: command cancelled"`。

### 5.3 `src/tools/registry.ts` / `src/tools/index.ts`

- `ToolRegistry.dispatch(name, args, signal?)` 透传 signal 给 `tool.handler`。
- `registerBuiltinTools` 中 bash 的 handler 改为 `(args, signal) => runBash(workdir, config.bashTimeout, config.maxOutputChars, args, signal)`。

## 6. web-server 层改动

### 6.1 `apps/web-server/src/types.ts`

- `WebEvent` 新增 `{ type: "turn_cancelled"; text: string }`。
- `WebTurnRunner.runTurn` 增加 `signal?: AbortSignal`。

### 6.2 `apps/web-server/src/session.ts`

- `SessionManager` 持有 `private currentAbort: AbortController | null`。
- `runTurn` 时创建 `AbortController` 存入 `currentAbort`，`finally` 中清空（仅当仍是同一个 controller）。
- 新增 `stop(): boolean`：若 `currentAbort` 非空则 `abort()` 并返回 `true`，否则返回 `false`。

### 6.3 `apps/web-server/src/http.ts`

新增端点：

```
POST /api/stop  → ctx.session.stop() → { ok: true }
```

幂等：无正在运行的 turn 时也返回 `{ ok: true }`。

## 7. 前端改动

### 7.1 `packages/web-client/src/api.ts`

新增：

```ts
export function stopMessage(): Promise<unknown> {
  return request("/api/stop", { method: "POST" });
}
```

### 7.2 `apps/web/src/hooks/useAgentEvents.ts`

- 新增 `stop()` 方法：调用 `stopMessage()`。
- `AgentState` 暴露 `canStop`（`busy && approval === null`）。
- SSE 事件处理新增 `turn_cancelled`：`setBusy(false)`、清空 streaming/streamBuf、`refresh()`。`turn_cancelled.text` 仅作即时提示/日志参考，权威消息以 `refresh()` 拉取的后端落盘结果为准。

### 7.3 `apps/web/src/components/InputBar.tsx`

- 新增 props：`canStop: boolean`、`onStop(): void`。
- 当 `canStop` 为 true 时，「发送」按钮原地渲染为「停止」，点击触发 `onStop`。
- 审批等待期间（`busy && !canStop`）仍禁用输入与按钮。

### 7.4 `apps/web/src/App.tsx`

把 `onStop`、`canStop` 透传给 `InputBar`。

### 7.5 `apps/web/src/components/ChatPanel.tsx` / `turns.ts`

渲染 `cancelled` 为 true 的 assistant 消息时，展示「(已中断)」标记。

## 8. 半成品落盘与标记

- 中断时，后端把已生成文字组装成 `{ role: "assistant", content: partialText, cancelled: true }`，通过 `sessionStore.append` 落盘。
- 前端 `turn_cancelled` 后 `refresh()`，从 `GET /api/session` 拉回带 `cancelled` 的消息并渲染标记。
- 标记存在后端 JSONL 里，刷新页面后仍保留。

## 9. 错误处理与锁

- 中断是正常结束，不触发 `agent_error`、不出现未处理 rejection。
- `withLock` 在 `runTurn` 正常返回后释放，后续可继续发消息。
- `/api/stop` 幂等，重复点击安全。

## 10. 测试策略

- `agentLoop`：流式生成期间中断、工具执行后中断、半成品落盘、`turn_cancelled` 广播、锁释放。
- `runBash`：abort 时强杀子进程并返回 cancelled。
- `SessionManager.stop`：有/无运行中 turn 两种。
- `openai.ts`：signal 透传（注入 fake client 断言 options.signal）。
- 前端：`InputBar` 停止按钮显隐与点击、`useAgentEvents` 的 `turn_cancelled` 处理。

## 11. 变更文件清单

- 修改 `src/core/types.ts`、`src/core/events.ts`、`src/core/loop.ts`、`src/core/harness.ts`。
- 修改 `src/providers/openai.ts`。
- 修改 `src/tools/bash.ts`、`src/tools/registry.ts`、`src/tools/index.ts`。
- 修改 `apps/web-server/src/types.ts`、`apps/web-server/src/session.ts`、`apps/web-server/src/http.ts`。
- 修改 `packages/web-client/src/api.ts`。
- 修改 `apps/web/src/hooks/useAgentEvents.ts`、`apps/web/src/components/InputBar.tsx`、`apps/web/src/components/ChatPanel.tsx`、`apps/web/src/components/turns.ts`、`apps/web/src/App.tsx`。
- 新增/修改对应测试文件。

## 12. 非目标（YAGNI）

- 不做 CLI REPL 中断。
- 不中断 `run_in_background` 后台任务、cron 定时任务、team 团队轮次。
- 不做审批等待期间的中断。
- 不回滚已执行完成的工具操作（改文件/跑完的命令）。
- 不做多会话并发中断（沿用现有单会话 `currentAbort`）。
