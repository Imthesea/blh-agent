## Bug：DeepSeek thinking 在最终回复后「消失」——`reasoning_content` 全链路未透传

- **日期**：2026-10-22
- **影响模块**：`src/providers/openai-compat.ts`、`src/runtime/loop.ts`、`src/contracts/types.ts`、`packages/web-protocol`、`apps/web`、`apps/web-server`
- **症状**：接 DeepSeek（thinking 模式）时，最后一轮的思维链在模型给出最终回复后从 thinking 面板「被吞掉」——前端看不到完整思考过程，会话恢复后也没有。
- **证据**：流式响应中每帧都带 `delta.reasoning_content`，但 provider 的 `stream()` 只消费 `delta.content` 与 `delta.tool_calls`，`reasoning_content` 被静默丢弃；session 文件里 assistant 消息也没有该字段。
- **根因**：DeepSeek 的思维链走独立字段 `reasoning_content`，不走 `content`。本项目从 provider → runtime → 事件协议 → 前端的整条链路只认识 `content`/`tool_calls`，对 `reasoning_content` 零透传，所以它从未被接收、从未落盘、也从未回传给下一轮。这不只是展示 bug：DeepSeek 官方要求**带 tools 的请求必须完整回传历史 assistant 的 `reasoning_content`（即使某轮为空也必须带 key）**，否则下一轮可能 400，破坏多轮正确性。
- **修复**：
  1. Provider：`stream()` 捕获并累加 `delta.reasoning_content`，发 `reasoning_delta` 流事件并写入 `done` 消息；`fromOpenAIMessage` 捕获非流式的 `message.reasoning_content`；`toOpenAIMessage` 的 assistant 分支无条件回传 `reasoning_content: message.reasoning_content ?? ""`（DeepSeek 带 tools 的硬性要求，空串对 openai 兼容系 provider 无害）。
  2. 类型：`ChatMessage` 加可选 `reasoning_content`；`ProviderStreamEvent` 加 `reasoning_delta`；`AgentEvent/WebEvent` 加 `assistant_reasoning_delta`，并加入 `WEB_EVENT_TYPES`（SSE 订阅白名单，漏掉则前端收不到）。
  3. Runtime：`streamAssistantMessage` 把 `reasoning_delta` 转发为 `assistant_reasoning_delta`；web-server 对该增量事件不截断（只截 tool 大字段）。
  4. 前端：live 阶段 `assistant_reasoning_delta` 合并进 thinking text step；`buildTurn` 从 assistant 消息的 `reasoning_content` 生成 persisted thinking 步骤（含最终回复那条消息的思考），保证 `turn_end` 后 refresh 重渲染仍可见。
- **回归测试**：`test/providers/openai.test.ts`（流式 reasoning_delta 捕获/累积、非流式捕获、assistant 消息回传含空串默认值）、`apps/web/src/components/turns.test.ts`（reasoning_content 渲染成 thinking 文本步骤，最终回复消息的 reasoning 也进 thinking）。
- **教训**：OpenAI 兼容不等于「只有 content/tool_calls」——各家把思考链挂在私有字段上（DeepSeek/Qwen/Kimi 是 `reasoning_content`）。任何新增模型 provider 接入时，先对照官方文档核对「非 content 的增量字段」和「多轮回传要求」。同类 bug 信号：面板某个区域在事件边界后内容消失，先怀疑「数据源字段根本没进事件流」，而不是「渲染被清了」。字段从底层到 UI 是 4 层链路，漏任何一层都会静默吞数据，修这类 bug 要一次打通全链路并用测试锁住每层。
