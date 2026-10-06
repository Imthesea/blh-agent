# 架构合理化方案

## 背景与目标

当前代码整体结构已经具备较清晰的领域划分：根包承载 Agent 内核与 CLI，`packages/` 承载共享库，`apps/` 承载 Web 前后端。这个基础不需要推倒重来。但随着功能继续增长，以下问题会提高维护成本：

1. `core` 反向依赖 `agents`、`jobs`、`memory`、`extensions`、`security` 等上层子系统，内核边界不稳定。
2. `Harness` 同时承担主对话、cron、dream、team、memory、MCP 资源释放等职责，正在成为上帝对象。
3. `buildHarness` 是事实上的 composition root，但缺少可执行的依赖规则，未来容易继续膨胀。
4. MCP 自动连接与 teammate 启动存在未追踪的后台异步任务，退出时可能无法完整等待或清理。
5. Web 关闭顺序尚未先停 listener 与 SSE，长连接可能拖住关闭流程。
6. `ChatMessage`、`AgentEvent`、`WebEvent` 在 core、web-server、web-client 中重复定义，协议容易漂移。

本方案的第一优先级：

- 更容易长期维护。
- 更清晰的模块边界。
- 更安全的生命周期。

## 范围说明

本方案覆盖当前架构评审中已识别的全部架构级优化：

1. 内核边界与依赖方向。
2. Harness 与 agentLoop 解耦。
3. 统一资源生命周期。
4. Web 关闭顺序与 SSE 生命周期。
5. 共享 Web 协议。
6. Web HTTP 模块拆分。
7. 配置发现目录与工作目录语义分离。
8. 主 Agent、subagent、teammate 执行循环收敛。

本方案不包含与架构边界无关的代码风格微调、UI 视觉重设计、业务功能扩展、依赖版本升级，以及尚未被评审识别出的未来问题。

## 决策记录

已确认以下约束：

1. **兼容性**：外部接口必须保持完全兼容，包括 CLI 命令、Web API、Web DTO、配置文件格式；内部目录与导入路径可以调整。
2. **生命周期**：退出时执行“取消并等待退出”，使用单一全局 10 秒 shutdown 预算，超时后强制处置并汇总失败。
3. **交付方式**：分阶段落地，每个阶段独立验证，不合并为一次性大迁移。本轮按用户要求整体保持未提交状态，review 后再决定提交切分方式。

### 全局 10 秒 shutdown 语义

10 秒预算作用于整个关闭流程，而不是每个资源单独 10 秒。避免多个后台资源串联等待导致关闭时间不可控。

正确语义：

1. 立即停止接受新请求。
2. 断开 SSE 连接。
3. 向所有后台资源传播 abort。
4. 后台 bash 立即强杀进程树，避免孤儿进程。
5. MCP 先关闭 stdin，短暂等待退出，超时后 kill。
6. team lead 与 teammate 将 abort 传播到模型调用与工具调用，等待异步栈 unwind。
7. 全局 deadline 到期后，对未完成资源执行 best-effort force dispose。
8. 汇总所有失败，不因单个资源失败阻止其他资源释放。
9. `dispose()` 幂等：第一次调用缓存 Promise，重复调用返回同一结果。

不建议等待后台任务自然完成。shutdown 的语义是取消，不是 drain。

## 目标架构

### 目录设计

```text
src/
  contracts/       # 纯协议与稳定类型：ChatMessage、ChatProvider、ToolDefinition、AgentEvent
  runtime/         # agentLoop、Harness、runtime ports、HookBus、AgentLock、LifecycleManager
  config/          # 配置加载，明确 configRoot 与 workdir
  agents/          # 多智能体，只依赖 contracts 与 runtime ports
  jobs/            # cron 与 background，只依赖 contracts 与 runtime ports
  memory/
  planning/
  providers/
  security/
  tools/
  extensions/
  workflow/
  cli/             # composition root，唯一允许依赖所有子系统
```

保留现有领域目录，不把所有子系统机械搬进 `features/`。本方案重点是切断反向依赖，而不是为了目录形式做大规模迁移。

### 依赖方向

```text
contracts
  ↑
runtime ports
  ↑
feature subsystems（agents、jobs、memory、planning、extensions、workflow 等）
  ↑
composition root（cli/buildHarness）
```

附加规则：

1. `contracts` 不允许导入应用模块，只允许导入 Node 标准库或纯类型依赖。
2. `runtime` 不允许导入具体 feature 子系统。
3. feature 子系统之间不直接互相导入，必须通过 contracts 或 runtime ports。
4. `cli/buildHarness` 是唯一允许依赖全部子系统的 composition root。
5. `apps/web-server` 不反向依赖根包，继续通过注入的 harness factory 隔离。
6. `packages/web-protocol` 不依赖 `apps/*`。

## 生命周期设计

新增统一资源契约：

```ts
export type ResourceKind =
  | "http-server"
  | "sse"
  | "session"
  | "background"
  | "cron"
  | "mcp"
  | "teammate";

export interface DisposableResource {
  id: string;
  kind: ResourceKind;
  cancel(): void;
  dispose(deadline: Deadline): Promise<void>;
}

export interface DisposeReport {
  timedOut: boolean;
  completed: string[];
  failed: Array<{
    id: string;
    kind: ResourceKind;
    error: string;
  }>;
}
```

`LifecycleManager` 职责：

1. 注册与注销资源。
2. 禁止 dispose 后注册新资源。
3. 先对全部资源并发执行 cancel，避免仍在运行的活动任务与释放流程竞争。
4. 按固定 phase 串行执行 dispose，phase 内资源并发释放：
   - `connections`：SSE 等需要先断开的连接。
   - `activity`：等待当前用户 turn 与已排队会话操作退出；单个轮次失败不阻断关闭。
   - `resources`：释放 harness、后台任务、cron、MCP、teammate。
   - `listener`：最后等待 HTTP listener 完成关闭。
5. 超时后执行 force dispose。
6. 返回 `DisposeReport`。
7. `dispose()` 幂等。

资源注册点：

- Web HTTP server。
- SSE broadcaster。
- Session 当前 turn 与后台 turn。
- BackgroundManager。
- JobsRuntime。
- MCP 自动连接任务与已连接 client。
- TeammateRuntime。

当前需要重点修复的未追踪异步点：

- `src/cli/buildHarness.ts` 中的 `void connectConfiguredMcp(...)`。
- `src/agents/team.ts` 中的 `void runtime.run()`。

## Web 关闭顺序

当前 close 顺序是先释放 harness，再关闭 HTTP server。目标顺序调整为：

1. server 立即停止接受新请求。
2. SSE broadcaster 关闭所有连接。
3. 取消当前 session turn 与后台 turn。
4. 释放 background、cron、MCP、teammate 等资源。
5. 等待 server listener 完成关闭；若超时，关闭残余连接。
6. 返回或抛出汇总后的 dispose 错误。

`SSEBroadcaster` 增加 `close()`，确保长连接不会拖住 `server.close()`。listener 资源区分两个动作：`cancel()` 立即调用 `stopAcceptingRequests()`；`dispose()` 等待同一关闭 Promise 完成，`forceDispose()` 关闭残余连接。

## 分阶段实施

### 阶段 0：架构守护

**目标**：先把依赖方向变成可执行约束，防止后续目录调整回退。

**修改**

1. 引入依赖检查工具（优先选择轻量脚本，避免不必要的新依赖）。
2. 将架构检查接入 `pnpm lint`。
3. 定义初始规则：
   - `src/contracts/**` 不允许导入应用模块。
   - `src/runtime/**` 不允许导入 `src/agents`、`src/jobs`、`src/memory`、`src/extensions`。
   - feature 子系统之间不允许直接互相导入。

**验收**

1. `pnpm lint` 包含架构规则。
2. 现有代码或阶段性豁免清单能通过检查。
3. 新增违规 import 会导致 lint 失败。

### 阶段 1：抽出 contracts 与 runtime

**目标**：建立稳定内核边界，降低 `Harness` 与 `agentLoop` 的耦合。

**修改**

1. 新增 `src/contracts`，迁移纯类型：
   - `ChatMessage`
   - `ChatProvider`
   - `ToolDefinition`
   - `ToolParameters`
   - `ChatUsage`
   - `AgentEvent`
2. 新增 `src/runtime`，迁移：
   - `agentLoop`
   - `Harness`
   - `HookBus`
   - `AgentLock`
   - runtime ports
3. `agentLoop` 不再依赖具体 `Harness` 类型，改为接收最小 runtime port。
4. `Harness` 依赖接口，而不是具体 `JobsRuntime`、`Memory`、`TeamRuntime`、`MCPRegistry`。
5. 一次性迁移全部内部调用方，不保留旧路径 re-export；外部接口仍由 CLI、Web API 与 workspace 包根入口保持兼容。

**验收**

1. CLI 与 Web 行为不变。
2. `runtime` 不再反向导入 feature 子系统。
3. 相关单元测试通过。
4. 生产代码、脚本与测试不再引用旧 `src/core` 路径。

**实施记录**

1. 旧 `test/core` 用例按被测模块迁移到 `test/config` 与 `test/runtime`，不删除有效回归测试。
2. 删除内部兼容 re-export 与 `TeamAgents` 旧别名；外部仍通过包根入口获得公开类型。
3. `scripts/swebench-run.ts` 虽未被内部代码引用，但它是 README 声明的用户可运行脚本，因此保留。

### 阶段 2：统一生命周期

**目标**：所有后台资源可追踪、可取消、可等待、可强制处置。

**修改**

1. 新增 `LifecycleManager` 与 `DisposableResource`。
2. 后台任务、cron、MCP、teammate、HTTP server、SSE 全部注册资源句柄。
3. 修复 MCP 自动连接的 fire-and-forget 问题。
4. 修复 teammate 的 fire-and-forget 问题。
5. Web close 改为标准关闭顺序。
6. `SSEBroadcaster` 增加 `close()`。
7. 实现 10 秒全局 deadline 与超时 force dispose。
8. CLI 退出与 Web close 复用同一 dispose 流程。

**验收**

1. `dispose()` 幂等。
2. 后台 bash 超时或 abort 后等待进程树退出。
3. MCP close 失败不影响其他 MCP client close。
4. teammate abort 能传播到模型调用与工具调用。
5. 关闭过程中新任务注册被拒绝。
6. 全局超时后返回失败报告。

**实施记录**

1. 新增 `@blh/lifecycle`：统一 `cancel → dispose → forceDispose` 流程，默认 10 秒全局预算，dispose 幂等，shutdown 后禁止注册新资源。
2. 释放按 `connections → activity → resources → listener` 四个 phase 串行推进；先并发 cancel 全部资源，phase 内并发 dispose，全局超时后 force dispose。
3. `buildHarness` 作为 composition root 注册 MCP 自动连接任务、MCP registry、`JobsRuntime` 与 `TeamRuntime`。
4. `MCPClient` / `MCPRegistry` 支持请求级 abort、pending request 失败、close 幂等，以及优雅关闭进行中的 force 升级；stdio 强杀进程树。
5. `TeamRuntime.dispose()` 会 abort team lead 与 teammate，并等待对应 run promise 退出；shutdown 后拒绝继续 spawn。
6. `JobsRuntime.stop()` 会中断并等待当前 dream/cron queue task，再停止后台命令。
7. Web server 使用独立外层 lifecycle，关闭顺序为：停止接受新连接 → 关闭 SSE → 取消并等待当前用户 turn 与已排队会话操作 → 释放 harness → 等待 listener 关闭；启动失败时也执行清理。
8. CLI 一次性模式、REPL 退出和 Web 信号退出都复用统一 dispose 流程。
9. `SSEBroadcaster.close()` 会断开全部长连接，关闭后拒绝新 SSE 订阅。
10. `StdioTransport` 保留独立的活动子进程句柄；优雅关闭等待期间调用 `forceClose()` 仍可升级为进程树强杀。
11. `TeamRuntime.stop()` 调整为可恢复的暂停与队友退出请求；只有 `cancel()` / `dispose()` 之后才禁止重新启动和继续 spawn。
12. `buildHarness` 将 MCP 自动连接延后到全部易失败构造完成之后，避免组装中途失败时留下后台连接。
13. Web server 在构建 runner 前校验端口，构建后立即注册 runner，后续启动失败统一走 lifecycle 清理。
14. 新增 `src/process/terminate.ts`，统一 Bash 工具与后台任务的进程树终止语义。
15. Windows 使用 `taskkill /T /F` 并等待被杀进程真实退出；tree kill 预算 8 秒，退出等待与降级强杀合计 2 秒，整体不超过 10 秒。
16. `runBash` 与 `BackgroundManager` 在 timeout / abort 后不再只等待 `taskkill` 命令返回，而是等待子进程 `close` 后才返回终态。

### 阶段 3：共享 Web 协议

**目标**：消除协议重复，避免前后端 DTO 漂移。

**修改**

1. 新增 `packages/web-protocol`。
2. 迁移：
   - `ChatMessage` 的 Web DTO
   - `AgentEvent`
   - `WebEvent`
   - `ApprovalDecision`
   - Session DTO
3. `apps/web-server` 与 `packages/web-client` 共同依赖该包。
4. 保留 wire format，不修改 JSON 字段与 SSE event 名称。

**验收**

1. Web API 响应结构不变。
2. SSE event 名称与 payload 不变。
3. web-server 与 web-client 测试通过。

**实施记录**

1. 新增 `@blh/web-protocol`，统一维护 `ChatMessage`、`AgentEvent`、`WebEvent`、`ApprovalDecision`、Session DTO 与 SSE 事件名。
2. `apps/web-server` 与 `packages/web-client` 依赖共享协议包；包根入口保留公开类型导出，内部 `bridge` / `types` 兼容 re-export 已删除。
3. `web-client` 的 API 响应类型与 `web-server` 的 HTTP 响应对象均直接使用共享 DTO；JSON 字段与 SSE event 名称不变。

### 阶段 4：拆分 Web HTTP

**目标**：降低 `http.ts` 单文件复杂度，提高路由可维护性。

**目标目录**

```text
apps/web-server/src/http/
  server.ts
  security.ts
  body.ts
  static.ts
  routes/
    session.ts
    message.ts
    log.ts
    approval.ts
    trace.ts
```

**验收**

1. 所有路由、状态码、CSRF 校验、Host 校验行为不变。
2. HTTP 测试全部通过。
3. 每类 route 可独立测试。

**实施记录**

1. 将 `http.ts` 拆分为 `http/server.ts`、`http/security.ts`、`http/body.ts`、`http/static.ts`、`http/context.ts`、`http/response.ts` 与 `http/routes/*`。
2. 删除旧 `src/http.ts` 与 `src/trace.ts` 兼容层，生产代码、脚本与测试直接引用新模块路径。
3. HTTP 路由按 session、message、log、approval、trace 分域；server 只负责 Host 校验、CSRF 校验、SSE 订阅、静态资源与错误兜底。
4. 新增 `http-modules.test.ts`，独立覆盖 loopback Host 判定、请求体 JSON 解析与超限拒绝；现有 HTTP 行为测试继续通过。

### 阶段 5：配置语义修正

**目标**：明确配置发现目录与工作目录的差异。

**修改**

1. `loadConfig` 改为显式输入：

```ts
loadConfig({
  configRoot: process.cwd(),
  workdir,
  cli,
});
```

2. 配置文件与 `.env` 从 `configRoot` 查找。
3. 运行产生的数据写入 `workdir`。
4. 文档明确 `--workdir` 不改变配置发现根目录。

**验收**

1. CLI 参数与配置文件格式兼容。
2. 从项目根启动并指定 `--workdir` 时，仍读取项目配置。
3. 配置相关测试通过。

**实施记录**

1. 配置实现迁移至 `src/config/config.ts` 与 `src/config/settings.ts`，删除旧 `src/core/config.ts` 与 `src/core/settings.ts` 兼容层。
2. `loadConfig()` 改为显式接收 `{ configRoot, workdir, cli }`；配置发现默认工作目录为 `configRoot`，运行数据目录为 `workdir`。
3. `buildHarness` 与 Web CLI 启动均以 `process.cwd()` 作为 `configRoot`，以 `--workdir` 作为运行数据目录。
4. README 与 CLI help 明确 `--workdir` 不改变 `.env` 与 `.blh/config.yaml` 的发现目录。
5. 新增 `configRoot` 与 `workdir` 分离测试，覆盖 `.env`、项目配置与运行目录返回值。

### 阶段 6：收敛 Agent 执行循环

**目标**：避免主 Agent、subagent、teammate 各自维护一套循环，导致 retry、流式回退、usage、abort、tracing 行为逐渐分叉。

**修改**

1. 基于 `runtime` 提供可配置的 AgentLoop profile。
2. 主 Agent 使用完整 profile：
   - 全量工具
   - memory
   - compaction
   - goal
   - tracing
3. subagent 使用受限 profile：
   - 内置工具
   - 独立消息上下文
   - 最大轮数限制
   - 不启用 memory、compaction、goal
4. teammate 使用独立上下文与受控工具集。
5. 统一以下行为：
   - provider retry
   - stream fallback
   - usage 归属
   - abort 传播
   - tool dispatch 错误格式
   - tracing event

**验收**

1. subagent 保留现有工具集与最大轮数限制。
2. teammate 保留现有团队协议与工作目录限制。
3. 主 Agent、subagent、teammate 的错误输出语义不变。
4. abort 在模型调用与工具调用两个阶段均生效。
5. usage 与 tracing 不再依赖共享 `lastUsage` 状态。

**实施记录**

1. 新增 `runAgentLoop()` 与 `AgentLoopProfile`：支持 `maxTurns` 和自定义工具 dispatcher；原 `agentLoop()` 保持 `Promise<void>` 兼容包装。
2. 主 Agent 继续使用完整 `AgentLoopRuntime`，保留全量工具、memory、compaction、goal、session、jobs 与 tracing。
3. `SubagentRunner` 改用受限 runtime profile：独立消息上下文、仅内置工具、30 轮上限，不注入 memory、compaction、goal、session 与 jobs。
4. `TeammateRuntime.work()` 改用单轮 profile：保留原有外层调度节奏、团队协议、计划门禁、hooks、scheduled-turn 安全上下文与任务工作目录限制。
5. 三类执行路径统一复用 provider 调用、工具参数解析、工具错误格式、abort 传播、tracing event 与 `chatWithUsage()` usage 归属；非流式路径不再读取共享 `lastUsage()`。
6. `Tracer.scoped()` 为 subagent 与 teammate 创建独立计数状态，usage ledger 分别记录到 `subagent` 与 `teammate:<name>` sid。
7. 无 `EventBus` 时不再执行可选 `await`，避免引入额外微任务导致“刚启动即取消”的 teammate 无法把 abort 传给模型调用。
8. 新增 profile、response-scoped usage、模型 abort、模型错误输出、teammate 计划门禁与旧 `lastUsage` 兼容性测试。

## 测试策略

每个阶段必须补对应回归测试：

1. **架构规则**：违规导入的负例测试或 lint CI 校验。
2. **runtime 边界**：agentLoop、Harness port、新路径引用测试。
3. **生命周期**：
   - 正常并发 dispose
   - 单资源失败
   - 全局超时
   - 重复 dispose 幂等
   - dispose 后注册被拒绝
4. **Web 协议**：DTO snapshot 与 SSE 序列化测试。
5. **HTTP 拆分**：现有 HTTP 测试不改语义，只允许跟随模块位置调整。
6. **配置**：`configRoot` 与 `workdir` 分离测试。
7. **执行循环收敛**：主 Agent、subagent、teammate 的行为等价性测试。

全量验证命令：

```powershell
pnpm lint
pnpm test
pnpm typecheck
pnpm -r --if-present typecheck
pnpm build
pnpm -r --if-present test
pnpm build:web
git diff --check
```

## 回滚策略

每个阶段独立验证并保持可回滚。本轮执行期间按用户要求统一不提交，最终 review 后再决定提交切分策略，满足以下原则：

1. 单个阶段可独立 revert。
2. 阶段 1 不保留旧路径 re-export；回滚阶段 1 需要连同内部调用方迁移一起回滚。
3. 阶段 2 生命周期改动必须有较完整回归测试，异常时优先回滚该阶段。
4. 阶段 3 与阶段 4 相互独立，可并行或调换顺序。
5. 阶段 6 必须在阶段 1 完成后执行；如果行为差异难以收敛，应回滚该阶段并保留现有独立循环。

## 明确不做

1. 不引入 NestJS、Fastify 等重框架。
2. 不立即把 runtime 抽成 workspace package。
3. 不一次性移动所有 feature 目录。
4. 不改变外部 CLI、Web API、配置文件格式。
5. 不把 shutdown 设计成等待任务自然完成。

## 建议执行顺序

1. 阶段 0：架构守护。
2. 阶段 1：contracts 与 runtime。
3. 阶段 2：统一生命周期。
4. 阶段 3：Web 协议。
5. 阶段 4：HTTP 拆分。
6. 阶段 5：配置语义。
7. 阶段 6：执行循环收敛。

推荐先实施阶段 0 与阶段 1。生命周期改造依赖清晰的 runtime 边界，先做阶段 0/1 能显著降低阶段 2 的风险；阶段 6 依赖阶段 1 的 runtime port，应最后实施。

## 执行状态

- [x] 阶段 0：架构守护。
- [x] 阶段 1：抽出 contracts 与 runtime。
- [x] 阶段 2：统一生命周期。
- [x] 阶段 3：共享 Web 协议。
- [x] 阶段 4：拆分 Web HTTP。
- [x] 阶段 5：配置语义修正。
- [x] 阶段 6：收敛 Agent 执行循环。

当前执行约定：本分支的阶段改动保持未提交状态，待用户整体 review 后再决定提交方式。
