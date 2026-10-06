# 会话事件溯源（append-only 事实与上下文投影）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把会话状态从「多个模块就地修改的 `ChatMessage[]`」改成「append-only 事件日志 + 纯投影」。事件文件是事实来源；内存状态、模型上下文和 `--continue` 恢复结果都由事件重放得到。压缩、回滚和消息取消都持久化为语义化事件，不再用全量替换或内存截断表达。

**架构：** 参考 pi 的 `SessionManager`：entry append-only、压缩是 `CompactionEntry`、上下文由 `buildSessionContext` 投影。本计划借鉴它的稳定事件序号、语义化压缩和投影思想，但不引入树、分叉、`parentId` 和 leaf 指针；本项目当前只需要单线会话。

**明确不采用的方案：**

- 不使用 `{ type: "replace_all", messages }`。`prepare()` 每轮都会执行，如果每次都把当前全量消息写入事件文件，会重新引入此前 `writeTranscript` 的平方级冗余。
- 不使用通用 `{ type: "edit", patch }`。system prompt、todo reminder、cancelled 标记各有更准确的建模方式；通用 edit 会掩盖真实业务语义，还会让事件流出现无效果事件。
- 不把 dream 的文件快照回滚并入本计划。那是文件系统操作事务，和会话事件溯源是两个问题。

**技术栈：** TypeScript（ESM，import 带 `.js` 后缀）、Node.js、Vitest。

---

## 现状问题

`messages` 是共享可变数组，当前至少有这些写入点：

- `src/runtime/harness.ts`：`push` 用户/dream 消息、`splice` cron/dream 回滚、`systemMessage.content =`
- `src/runtime/loop.ts`：`push` assistant/tool/reminder/partial、`splice` 压缩、`unshift` system、`last.content =`
- `src/jobs/runtime.ts`：`push` cron/background 注入
- `src/agents/team.ts`：`push` team 注入

由此产生的问题不只是“代码分散”：

1. **压缩只改内存。** `SessionStore` 只 append 裸消息，不记录压缩结果；`--continue` 恢复的是压缩前历史，压缩在续接后失效。
2. **回滚只改内存。** cron/dream 失败时 `splice` 内存，但已产生的消息早已落盘；下次 `--continue` 会恢复本应丢弃的回合。
3. **`prepare()` 每轮都可能改变消息。** 如果把它的返回值当作状态替换，事件文件会反复保存近似全量上下文。
4. **Compactor 就地修改输入。** `toolResultBudget` / `microCompact` / `fitToolResults` 直接改 `msg.content`，调用方无法安全传入 readonly 视图。
5. **system prompt 被当作会话事实。** memory 注入后 system 每轮变化；持久化它只会重复保存大段运行时可重建内容。
6. **REPL 用消息下标找新增回复。** 压缩可能让 `messages.length` 变小，按消息下标找最后一条 assistant 文本不可靠；改用基于事件 seq 的 `transcript.lastAssistantTextAfter(before)`。

---

## 核心设计

### 1. 事件文件格式

新会话文件第一行是 header，后续每行是一个事件：

```jsonl
{"type":"session","version":1,"id":"...","cwd":"...","createdAt":"..."}
{"type":"message","seq":1,"timestamp":"...","message":{"role":"user","content":"hi"}}
{"type":"message","seq":2,"timestamp":"...","message":{"role":"assistant","content":"done"}}
{"type":"message","seq":3,"timestamp":"...","message":{"role":"tool","tool_call_id":"c1","content":"ok"}}
{"type":"compaction","seq":4,"timestamp":"...","message":{"role":"user","content":"...summary..."},"firstKeptSeq":3}
{"type":"message","seq":5,"timestamp":"...","message":{"role":"assistant","content":"continue"}}
{"type":"rollback","seq":6,"timestamp":"...","to":4}
{"type":"messageCancelled","seq":7,"timestamp":"...","target":5}
```

类型定义放在 `src/session/transcript.ts`：

```ts
export interface SessionEventBase {
  seq: number;
  timestamp: string;
}

export type SessionEvent =
  | (SessionEventBase & {
      type: "message";
      message: ChatMessage;
    })
  | (SessionEventBase & {
      type: "compaction";
      message: ChatMessage;
      firstKeptSeq: number | null;
    })
  | (SessionEventBase & {
      type: "rollback";
      to: number;
    })
  | (SessionEventBase & {
      type: "messageCancelled";
      target: number;
    });
```

语义：

- `message`：追加一条事实消息。`seq` 同时是这条消息的稳定身份。
- `compaction`：上下文变为 `message`（摘要消息）加上 `firstKeptSeq` 及之后仍存在的消息；`firstKeptSeq === null` 表示没有保留原始消息。事件不保存全量历史。
- `rollback`：丢弃 `seq > to` 的有效事件，但 rollback 事件本身保留在日志中。文件仍 append-only。
- `messageCancelled`：把 `target` 指向的 assistant 消息投影为 `cancelled: true`。如果目标已被压缩移出当前上下文，事件仍保留为事实，但不再产生可见消息变化。

### 2. 投影规则

`projectMessages(events)` 是纯函数：

1. 先处理 rollback：维护有效事件列表；遇到 rollback 时保留 `seq <= to` 的有效事件，再把 rollback 事件本身追加到有效列表。
2. 再按有效事件顺序投影：
   - `message`：追加消息，并记录其来源 `seq`
   - `compaction`：上下文变为 `[event.message, ...原上下文中 seq >= firstKeptSeq 的消息]`
   - `messageCancelled`：如果目标消息仍在当前上下文，设置 `cancelled: true`
   - `rollback`：不直接产生消息
3. system prompt 不参与事件投影，由 `Transcript` 单独持有并在 `messages` 视图开头拼回。

这样 rollback 到压缩之前会自然恢复压缩前消息；rollback 到压缩之后则保留压缩效果。

### 3. `Transcript` API

```ts
export interface TranscriptOptions {
  system?: ChatMessage | null;
  events?: readonly SessionEvent[];
  persist?: (event: SessionEvent) => void;
}

export class Transcript {
  constructor(options: TranscriptOptions = {});

  /** 原始事件日志（含 rollback 事件）；投影时才决定哪些事件有效。 */
  get events(): readonly SessionEvent[];

  /** 当前内存中的 system 消息；可能为 null。 */
  get systemMessage(): ChatMessage | null;

  /** [system?, ...conversation]，供模型和现有读逻辑使用。 */
  get messages(): readonly ChatMessage[];

  /** 当前最大事件 seq；作为回滚边界。 */
  get lastSeq(): number;

  /** 追加非 system 消息，返回消息 seq；传入 system 时抛错。 */
  append(message: ChatMessage): number;

  /** 更新内存中的 system prompt；不产生事件、不落盘。 */
  setSystem(content: string | null): void;

  /** 追加压缩事件；firstKeptSeq 为 null 表示全部摘要。 */
  compact(summaryMessage: ChatMessage, firstKeptSeq: number | null): void;

  /** 持久化 rollback 事件，并重放得到内存状态；seq 必须是 0 或已有事件 seq。 */
  rollbackTo(seq: number): void;

  /** 标记某条 assistant 消息取消；目标不需要仍在当前上下文中。 */
  cancelMessage(seq: number): void;

  /** 返回模型视图下标对应的消息事件 seq；system/摘要消息返回 null。 */
  messageSeqAt(index: number): number | null;

  /** 返回某 seq 之后最后一条 assistant 文本；替代 messages.length 边界。 */
  lastAssistantTextAfter(seq: number): string;

  /** 返回某 seq 之后最后一条 assistant 消息的事件 seq；没有则返回 null。 */
  lastAssistantSeqAfter(seq: number): number | null;
}
```

关键不变量：

1. **写前日志：** 先校验并调用 `persist(event)`，成功后才更新内存。`persist` 抛错时状态和 seq 都不变。
2. **入口克隆：** `append` / `compact` 对传入 message 做深克隆，事件和 `messages` 视图持有冻结对象，避免外部绕过事件修改状态。
3. **append-only：** 磁盘文件只追加，不重写、不截断。
4. **system ephemeral：** system prompt 不落盘；新会话和 `--continue` 时由 Harness 重建。
5. **上下文变换 ephemeral：** Compactor 的本地变换（工具结果落盘、snip 等）只影响本次模型输入，不修改事实消息。

### 4. Compactor 返回压缩计划

`CompactorPort` 不再把“消息数组”当作唯一结果，而返回上下文和可选的持久化压缩计划：

```ts
export interface CompactionPlan {
  summaryMessage: ChatMessage;
  /** 输入事实 messages 中第一条保留的原始消息下标；null 表示全量摘要。 */
  firstKeptIndex: number | null;
}

export interface PreparedContext {
  /** 本轮传给 provider 的上下文，可包含本地压缩变换。 */
  messages: ChatMessage[];
  /** 只有语义压缩才设置；本地变换不设置。 */
  compaction?: CompactionPlan;
}

export interface CompactionPort {
  prepare(messages: readonly ChatMessage[], activeRequest: string): Promise<PreparedContext>;
  reactiveCompact(messages: readonly ChatMessage[], activeRequest: string): Promise<PreparedContext>;
  compactHistory(messages: readonly ChatMessage[], activeRequest: string): Promise<PreparedContext>;
}
```

含义：

- `toolResultBudget`、`microCompact`、`fitToolResults`、`snipCompact` 是上下文准备，不写事件。
- `compactHistory` 返回 `firstKeptIndex: null`。
- `reactiveCompact` 返回第一个保留消息的下标；没有保留尾部时为 `null`。
- `prepare` 只有走到摘要压缩时才返回 `compaction`。
- 语义压缩计划中的下标相对于传给 compactor 的输入事实消息，而不是本地变换后的 `PreparedContext.messages`。

---

## 文件结构

- 新增 `src/session/transcript.ts`
- 修改 `src/session/store.ts`
- 修改 `src/runtime/ports.ts`
- 修改 `src/runtime/loop.ts`
- 修改 `src/runtime/harness.ts`
- 修改 `src/compaction/compactor.ts`
- 修改 `src/jobs/runtime.ts`
- 修改 `src/agents/team.ts`
- 修改 `src/agents/subagent.ts`
- 修改 `src/agents/teammate.ts`
- 修改 `src/cli/repl.ts`
- 修改 `src/cli/main.ts`
- 修改 `src/contracts/types.ts`（provider 参数放宽为 readonly）
- 新增/更新对应测试

---

## 任务 1：先纯化 Compactor 并返回压缩计划

**文件：**

- 修改 `src/compaction/compactor.ts`
- 修改 `src/runtime/ports.ts`
- 测试 `test/compaction/compactor.test.ts`

> 这一步必须先做。否则任务 4 无法安全把 readonly `transcript.messages` 传给 compactor，也无法区分“本地上下文变换”和“需要持久化的语义压缩”。

- [ ] 添加失败测试：
  - `toolResultBudget`、`microCompact`、`fitToolResults` 不修改传入数组和消息对象
  - `prepare` 无摘要时返回 `{ messages, compaction: undefined }`
  - `compactHistory` 返回 `firstKeptIndex: null`
  - `reactiveCompact` 返回正确的 `firstKeptIndex`
- [ ] 把三处 `msg.content = ...` 改为 map/构造新消息对象
- [ ] 引入 `PreparedContext`、`CompactionPlan`
- [ ] 更新 `CompactorPort` 三个方法签名
- [ ] 运行：

```bash
npx vitest run test/compaction/compactor.test.ts
npx tsc --noEmit
```

---

## 任务 2：实现 `SessionEvent` 与 `Transcript`

**文件：**

- 新增 `src/session/transcript.ts`
- 新增 `test/session/transcript.test.ts`

- [ ] 添加失败测试：
  - `append` 产生 message 事件，不修改调用方对象
  - `compact(summary, firstKeptSeq)` 投影为摘要 + 保留消息
  - `compact(summary, null)` 只保留摘要
  - `rollbackTo` 会产生 rollback 事件，并恢复 `to` 之后的事件
  - 压缩后再 rollback 到压缩前，能恢复压缩前消息
  - `cancelMessage` 投影 `cancelled: true`
  - `setSystem` 只影响 `messages` 视图，不产生事件
  - `persist` 抛错时内存状态和下一个 seq 不变
  - `lastAssistantTextAfter(lastSeq)` 在压缩导致消息长度下降后仍正确
- [ ] 实现事件类型、纯 `projectMessages`、`Transcript`
- [ ] 实现深克隆/冻结 helper，确保事件入口后的消息不可被外部就地修改
- [ ] 实现 write-ahead 提交流程：校验 event → persist → 更新内存
- [ ] 运行：

```bash
npx vitest run test/session/transcript.test.ts
```

---

## 任务 3：改造 `SessionStore`

**文件：**

- 修改 `src/session/store.ts`
- 修改 `src/runtime/ports.ts`
- 新增/更新 `test/session/store.test.ts`

- [ ] 添加 `SessionHeader`：

```ts
export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
}
```

- [ ] `SessionStore.create(workdir)` 写入 header
- [ ] `SessionStore.open(filePath)` 读取或惰性加载现有事件，记录最大 `seq`，供后续 `appendEvent` 校验
- [ ] 新增：
  - `loadSession(filePath): { header: SessionHeader | null; events: SessionEvent[] }`
  - `appendEvent(event: SessionEvent): void`
  - `loadMessages(filePath): ChatMessage[]`（投影结果，供兼容/调试）
- [ ] `appendEvent` 校验 `seq` 严格递增，再 append JSONL
- [ ] 兼容旧格式：
  - 文件无 header 时视为 legacy
  - 裸消息行包装成 `message` 事件并分配 `seq`
  - 后续新事件接着 legacy 最大 seq 递增
  - 不做 in-place 重写
- [ ] `SessionStorePort` 改为：

```ts
export interface SessionStorePort {
  readonly path: string;
  appendEvent(event: SessionEvent): void;
}
```

- [ ] 添加测试：
  - 新文件第一行是 session header
  - message/compaction/rollback/cancel 事件可完整恢复
  - legacy 裸消息可加载并继续追加事件
  - rollback 后 `loadMessages` 不包含被回滚消息
  - 压缩后 `loadMessages` 是摘要 + 保留消息，而不是压缩前全量
- [ ] 运行：

```bash
npx vitest run test/session/store.test.ts
npx tsc --noEmit
```

---

## 任务 4：主循环改用 `Transcript`

**文件：**

- 修改 `src/runtime/loop.ts`
- 修改 `src/agents/subagent.ts`
- 修改 `src/agents/teammate.ts`
- 修改 `src/contracts/types.ts`
- 测试 `test/runtime/loop.test.ts`、`test/runtime/boundaries.test.ts`

核心签名：

```ts
export async function runAgentLoop(
  harness: AgentLoopRuntime,
  transcript: Transcript,
  activeRequest = "",
  events?: EventBus,
  signal?: AbortSignal,
  profile: AgentLoopProfile = {},
): Promise<AgentLoopResult>;
```

模型上下文使用局部变量，而不是修改 transcript：

```ts
let modelMessages: readonly ChatMessage[] = transcript.messages;

for (;;) {
  if (compactor) {
    // 语义压缩必须基于事实消息计算，firstKeptIndex 才能映射回事件 seq。
    const prepared = await compactor.prepare(transcript.messages, activeRequest);
    if (prepared.compaction) {
      const plan = prepared.compaction;
      const firstKeptSeq =
        plan.firstKeptIndex === null
          ? null
          : transcript.messageSeqAt(plan.firstKeptIndex);
      transcript.compact(plan.summaryMessage, firstKeptSeq);
      modelMessages = transcript.messages;
    } else {
      modelMessages = withSystem(prepared.messages, transcript.systemMessage);
    }
  }

  // provider 调用使用 modelMessages
  // 成功后 transcript.append(message)，并重置 modelMessages = transcript.messages
}
```

- [ ] 所有 `messages.push` 改为 `transcript.append`
- [ ] 删除 `messages.splice` / `unshift` / `last.content =`
- [ ] `restoreSystem` 删除，改为 `withSystem` 纯函数
- [ ] prompt-too-long 时基于 `transcript.messages` 调用 `reactiveCompact`，得到 `compaction` 后追加事件并重试
- [ ] compact 工具批次结束时基于 `transcript.messages` 调用 `compactHistory`，再追加 compaction 事件
- [ ] todo reminder 改为独立 user 消息事件：
  - 每个 tool message 在工具执行完成后立即 append，不再延迟批量写入
  - 本批次工具执行完后调用 `todoManager.noteRound(usedTodo)`
  - 如有提醒，追加 `{ role: "user", content: reminder }`
  - 不修改已经 append 的 tool message
- [ ] `markLastAssistantCancelled` 改为 `transcript.cancelMessage(lastAssistantSeq)`
- [ ] `TurnCancelledError` partial 直接以 `cancelled: true` append
- [ ] `ChatProvider` 所有接收消息数组的参数统一改为 `readonly ChatMessage[]`
- [ ] REPL/harness 回复输出改用 `transcript.lastAssistantTextAfter(lastSeq)`
- [ ] `subagent.ts` / `teammate.ts` 构造内存 `Transcript`，不持久化
- [ ] 更新测试后运行：

```bash
npx vitest run test/runtime/loop.test.ts test/runtime/boundaries.test.ts
npx tsc --noEmit
```

---

## 任务 5：Harness、Jobs、Team 接入

**文件：**

- 修改 `src/runtime/harness.ts`
- 修改 `src/runtime/ports.ts`
- 修改 `src/jobs/runtime.ts`
- 修改 `src/agents/team.ts`
- 测试 `test/runtime/harness.test.ts`、`test/jobs/runtime.test.ts`、`test/agents/team.test.ts`

端口签名：

```ts
export interface JobsPort {
  consumeAndInjectCron(transcript: Transcript): ScheduledJobPort[];
  injectBackgroundResults(transcript: Transcript): number;
  // 其余保持不变
}

export interface TeamAgentsPort {
  consumeAndInjectTeam(transcript: Transcript): number;
  // 其余保持不变
}
```

Harness：

- [ ] 新增 `newTranscript(events?: readonly SessionEvent[]): Transcript`
  - `events` 来自 `SessionStore.loadSession`
  - persist 回调调用 `sessionStore?.appendEvent`
- [ ] `runTurn`：
  - `transcript.append(userMessage)`
  - memory system 更新改为 `transcript.setSystem(...)`
  - memory extract 使用 readonly messages
- [ ] `runScheduledTurn`：
  - 记录 `boundary = transcript.lastSeq`
  - 注入 cron
  - 错误或 abort 时调用 `transcript.rollbackTo(boundary)`
  - rollback 事件随原始消息一起落盘，`--continue` 不再恢复失败回合
- [ ] `runDreamTurn` 同样使用 `lastSeq` 和 `rollbackTo`
- [ ] `runTeamTurn` 改用 `Transcript`
- [ ] Jobs/Team 注入方法只调用 `transcript.append`
- [ ] 相关接口的 `ChatMessage[]` 参数统一改为 `readonly ChatMessage[]` 或 `Transcript`
- [ ] 运行：

```bash
npx vitest run test/runtime/harness.test.ts test/jobs/runtime.test.ts test/agents/team.test.ts
npx tsc --noEmit
```

---

## 任务 6：CLI 与 REPL

**文件：**

- 修改 `src/cli/repl.ts`
- 修改 `src/cli/main.ts`
- 测试 `test/cli/repl.test.ts`、`test/integration/session.test.ts`

- [ ] `TurnRunner` 持有 `Transcript`：

```ts
export interface TurnRunner {
  newTranscript(events?: readonly SessionEvent[]): Transcript;
  runTurn(transcript: Transcript, text: string, events?: EventBus): Promise<void>;
  runScheduledTurn?(transcript: Transcript, signal?: AbortSignal): Promise<void>;
  runTeamTurn?(transcript: Transcript, signal?: AbortSignal): Promise<void>;
  runDreamTurn?(transcript: Transcript, signal?: AbortSignal): Promise<void>;
  // 其余保持不变
}
```

- [ ] REPL 新增回复边界改用 `transcript.lastSeq`
- [ ] 按消息下标的旧回复输出改为 `transcript.lastAssistantTextAfter(before)`
- [ ] `-p` 模式创建不持久化的 `Transcript`
- [ ] 新 REPL：
  - `SessionStore.create` 写 header
  - `harness.newTranscript()`
- [ ] `--continue`：
  - `SessionStore.open(file)`
  - `loadSession(file).events`
  - `harness.newTranscript(events)`，不把历史作为 baseline 重复写入
  - system prompt 由 Harness 重建
- [ ] 更新集成测试：
  - 一轮后文件包含 header + user + assistant + tool 事件，且不包含 system
  - 压缩后继续写入同一文件
  - `--continue` 加载后上下文是压缩后投影
  - cron/dream 失败回滚后，重新打开文件不包含失败回合消息
- [ ] 运行：

```bash
npx vitest run test/cli/repl.test.ts test/integration/session.test.ts
npx tsc --noEmit
```

---

## 任务 7：全量验证与防回归

- [ ] 运行全量测试：

```bash
npx vitest run
```

- [ ] 运行类型检查：

```bash
npx tsc --noEmit
```

- [ ] 检查禁止模式：

```bash
rg -n "messages\\.(push|splice|unshift)|\\.content\\s*=" src
```

预期：业务代码中不再有对共享 `messages` 的就地写入；测试或局部构造数组的代码除外，如存在需逐条确认。

- [ ] 检查事件文件尺寸行为：
  - 无压缩长会话只按消息线性增长
  - `prepare` 无语义压缩时不新增 compaction 事件
  - 多次压缩不会重复保存全量历史

---

## 执行顺序与风险

1. 任务 1 必须先行，否则 readonly 消息和语义压缩计划无法落地。
2. 任务 2~3 可以独立交付，先锁死事件语义和持久化格式。
3. 任务 4 是最大改动，重点验证 provider 输入与事实状态分离后，工具调用/结果顺序不变。
4. 任务 5~6 依赖任务 4 的签名。
5. rollback 事件会改变现有 `--continue` 行为：失败 cron/dream 消息不再复活，这是有意修复，必须有测试锁定。
6. 工具消息批量 append 会改变事件写入时机，但保持模型上下文中的顺序；需要覆盖 abort 场景。

## 自检

- **压缩不丢历史：** 原始 message 事件保留；`compaction` 只记录摘要和边界。
- **续接不白压：** `loadSession` 投影 compaction 事件，`--continue` 得到压缩后上下文。
- **回滚不复活：** rollback 本身持久化，重放时会截断有效事件。
- **无全量替换：** 不存在 `replace_all`，本地上下文变换不进入事件流。
- **无通用 edit：** system 是 ephemeral，todo reminder 是独立 user 消息事件，取消使用语义事件。
- **写入收敛：** 所有事实消息来自 `Transcript.append` / `compact` / `rollbackTo` / `cancelMessage`。
