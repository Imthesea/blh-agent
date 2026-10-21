# C4b · 摘要元数据化实施方案（已拍板 Z）

- 日期：2026-10-21
- 状态：已拍板方案 Z（最合理，非最小）；待实施
- 前置：S0–S3 + C4a 已落地（C4a 的 relocateCompactionSummary 将被 Z 替换）

## 1. 为什么是 Z（拍板理由）

压缩摘要本质是**会话元数据**，不是**一条消息**。当前把它存成 `role:"user"` + `isCompactionSummary` 的消息，是一个类型层面的谎言——数据模型说「用户说了 X」，用户没说过。这个谎言一路漏进事件日志（source of truth）、投影、memory recall、goal、daily-log、前端，处处要打补丁忽略它。

以「事件日志是唯一事实来源」为原则，source of truth 里躺一条假 user 消息本身就不合理。Z 是唯一自洽的方案：

- **X（消费点过滤）**：不解决类型谎言，只是把「记得忽略这个字段」散落到多处——最脆弱。
- **Y（只清投影层）**：投影/前端干净了，事件日志里假消息仍在——自相矛盾。
- **Z（改 schema）**：`compaction.summary: string` 取代 `message: ChatMessage`，假 user 消息与 `isCompactionSummary` 全链路消失——唯一诚实。

## 2. 设计总览

- compaction 事件从 `{ message: ChatMessage, ... }` 改为 `{ summary: string, ... }`；`message` 仅作旧事件向后兼容读取。
- 摘要不再进投影（projected）；`Transcript` 新增 `summaryText: string | null`。
- 模型载荷：system 尾部拼 `[Archived Context Summary]` 段（每请求现算，来自 `transcript.summaryText`）。
- 前端折叠条：checkpoint 从独立字段 `summary` 来（不再靠假 user 消息）。
- 连续压缩：`summarizeHistory` 注入 `priorSummary`，防丢前序摘要。
- 预算修正：`compactorBudget` 扣掉摘要 token，防 gate 被骗。

## 3. 文件落点与验收（逐文件）

### 3.1 `src/contracts/types.ts`
- `ChatMessage` 删除 `isCompactionSummary?: boolean`。
- 验收：全仓无 `isCompactionSummary` 引用。

### 3.2 `src/session/transcript.ts`
- `SessionEvent.compaction`：`message: ChatMessage` → `summary?: string` + `message?: ChatMessage`（旧兼容）；`firstKeptSeq`/`firstKeptUserSeq` 不变。
- 新增 helper：`compactionSummary(event)` = `event.summary ?? event.message?.content ?? ""`。
- `projectEvents` 返回 `{ projected, latestSummary }`：compaction 只更新 `latestSummary`、不再把摘要 push 进 projected。
- 新增导出 `projectSummary(events): string | null`（供历史路径）。
- `Transcript`：
  - 字段 `summaryText: string | null`；构造器全量重放时同步。
  - `compact(summary: string, firstKeptSeq, firstKeptUserSeq)`：事件写 `summary`；增量更新 `projected`（不含摘要）与 `summaryText`。
  - `rollbackTo`：全量重放并同步 `summaryText`（与 `projectEvents` 共用同一函数）。
  - `messagesWithIds` 去掉 `sourceSeq === null ? "summary"` 特判。
- 验收：旧事件（有 `message`）与新事件（有 `summary`）投影一致；`messages`/`conversation` 不含摘要；rollback 后 `summaryText` 正确回退。

### 3.3 `src/session/store.ts`
- `SessionStore` 新增 `static loadSummary(filePath): string | null`（= `projectSummary(loadSession(filePath).events)`）。
- 验收：历史会话摘要可独立读取，不在 web-server 重复解析。

### 3.4 `src/compaction/compactor.ts`
- 删除 `summaryMessage`（`[已压缩]…对话摘要…` 包装）。
- `summarizeHistory(messages, priorSummary?)`：priorSummary 时输入为 `[Previous archived context]…\n\n[Newly archived context]…`。
- `compactHistory`/`reactiveCompact` 返回 `compaction: { summary: string, firstKeptIndex, firstKeptUserIndex }`；`messages` 置 `[]`（有 compaction 时 loop 用 transcript 投影）。
- `prepare(..., priorSummary?)` 透传。
- 验收：摘要为纯文本（无 `[已压缩]`/JSON 包装）；连续两次压缩后摘要仍含第一轮事实。

### 3.5 `src/runtime/ports.ts`
- `CompactionPlan.summaryMessage: ChatMessage` → `summary: string`。
- `CompactionPort` 三方法签名加 `priorSummary?: string`。

### 3.6 `src/runtime/loop.ts`
- 删除 `relocateCompactionSummary`（C4a）；新增 `injectArchivedSummary(messages, summaryText)`：system 尾部拼 `[Archived Context Summary]\n\n{summary}`。
- `compactTranscript`：`transcript.compact(plan.summary, firstKeptSeq, firstKeptUserSeq)`。
- 三处 compactor 调用透传 `transcript.summaryText` 作为 priorSummary。
- 预算修正：`compactorBudget = max(0, floor(promptBudget / ratio) - estimateTextTokens(summaryText))`。
- 汇聚点（sanitizeReplay 前）：`sanitizeReplay(injectArchivedSummary(modelMessages, transcript.summaryText))`。
- 验收：provider 载荷 conversation 无摘要、system 含 `[Archived Context Summary]`；三处调用都带 priorSummary。

### 3.7 `src/runtime/harness.ts`
- 无需过滤：`transcript.messages` 已不含摘要，memory recall/extract 自动不再看到摘要。
- 验收：memory recall 输入不含摘要（现有行为因 Z 自动成立）。

### 3.8 `src/session/daily-log.ts`
- 无需改：`messages` 不含摘要，`<day>.md` 自动不再出现 `### user` 摘要包装。

### 3.9 `packages/web-protocol/src/index.ts`
- `ChatMessage` 删除 `isCompactionSummary`。
- `SessionInfo` 与 `SessionMessagesResponse` 增加 `summary: string | null`。

### 3.10 `apps/web-server`
- `types.ts`：`SessionEventLike` 补 `summary?`、`firstKeptUserSeq?`；`TranscriptLike` 补 `summaryText`；`SessionStoreModule` 补 `loadSummary`。
- `routes/session.ts`：`/api/session` 返回 `summary = transcript.summaryText`；`/api/sessions/:file` 返回 `summary = sessionStore.loadSummary(filePath)`。
- 验收：两个 API 对同一会话返回等价 summary。

### 3.11 `apps/web/src`
- `turns.ts`：`groupMessages(messages, summary)`——去掉 `isCompactionSummary` 分支，改为 summary 非空时在头部插入 `CheckpointBlock`。
- `ChatPanel.tsx`：接收并透传 `summary`。
- `useAgentEvents.ts`：`AgentState` 增加 `summary`；`refresh` 从 `getSession()` 取。
- 验收：live 与历史视图都渲染折叠条，位置在最前。

## 4. 迁移与兼容

- 旧 compaction 事件（`message` 字段）：`compactionSummary` 用 `message.content` 兜底，读侧自动迁移，无需改旧文件。
- `--continue`：`projectSummary`/`projectEvents` 对旧事件天然兼容。
- 旧事件里的 `isCompactionSummary: true` 标记被忽略（字段从类型删除，JSON 多字段无害）。

## 5. 测试影响（须全量更新）

- `test/session/transcript.test.ts`：6 处断言 `messages` 含 `user("summary")` → 改为断言 `transcript.summaryText`。
- `test/compaction/compactor.test.ts`：`[已压缩]`/`对话摘要（仅供参考）`/`summaryMessage` 断言 → 改 `summary` 纯文本；连续压缩 priorSummary 用例。
- `test/runtime/loop.test.ts`：`[已压缩]` 从 messages 移到 system；C4a 用例改断言 `injectArchivedSummary` 文案。
- `apps/web-server/test/http.test.ts`：`SessionMessagesResponse` 增加 `summary` 字段断言。
- 新增：`projectSummary` / `loadSummary` 单测。

## 6. 明确不做

- 不做摘要的摘要链（多级合并）。
- 不把摘要传给 memory recall（默认输入已不含摘要）。
- 不迁 legacy v0 裸消息文件。
- 不引入第三套摘要存储（只存 `summary` 一处，投影与 system 都从它派生）。