# src 目录架构图

> 本文档梳理 `src/` 下 18 个目录、78 个源文件的职责与分层关系，帮助快速定位代码。
> 项目名：`blh-claude-code-ts`（一个可编程的 Claude Code 风格智能体运行时，TypeScript 实现）。

---

## 一、整体分层（总览）

```
┌────────────────────────────────────────────────────────────────────────┐
│                         入口层  cli                                     │
│   main.ts（入口分发）  repl.ts（交互循环）  web.ts（Web 工作台）          │
│   buildHarness.ts（装配车间：把所有依赖组装成 Harness）                  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 组装并驱动
┌───────────────────────────────────▼────────────────────────────────────┐
│                       运行时核心  runtime                                │
│   harness.ts（组合根）  loop.ts（agent 主循环）  ports.ts（端口层）       │
│   hooks.ts（钩子总线）  events.ts（事件总线）  agent-lock.ts（互斥锁）    │
│   parse-args.ts（参数解析）  security-context.ts（权限上下文）            │
└──────┬───────────────────┬──────────────────────┬───────────────────────┘
       │ 契约层（被所有层引用）│ 能力模块（业务能力）    │ 基础设施/适配器（对接外部）
       ▼                    ▼                      ▼
┌──────────────┐  ┌─────────────────────┐  ┌──────────────────────────────┐
│ contracts    │  │ agents / planning    │  │ providers（LLM 适配器）       │
│ （全局类型/   │  │ goals / memory       │  │ extensions（MCP + 技能）      │
│   协议/纯函数）│  │ jobs / workflow      │  │ tools + process（内置工具）   │
│              │  │ compaction（上下文）   │  │ security / session / tracing │
│              │  │                      │  │ config（配置）                │
└──────────────┘  └─────────────────────┘  └──────────────────────────────┘
```

**依赖方向（单向，自上而下）：**

```
cli  ──►  runtime  ──►  能力模块 / 基础设施
              │
              └──►  contracts（最底层，被一切引用，自身不依赖业务模块）
```

---

## 二、目录速览

| 目录 | 一句话作用 | 文件数 |
|---|---|---|
| [cli](#31-入口层-cli) | 程序入口与交互层（命令行、REPL、Web 入口、装配） | 4 |
| [runtime](#32-运行时核心-runtime) | agent 主循环与组装中枢 | 8 |
| [contracts](#33-契约层-contracts) | 全局共享的类型、协议、纯函数 | 6 |
| [agents](#34-多智能体协作-agents--planning--goals) | 多智能体团队协作的执行层 | 6 |
| [planning](#34-多智能体协作-agents--planning--goals) | 任务仓库与待办清单 | 3 |
| [goals](#34-多智能体协作-agents--planning--goals) | 目标设定与达成判定 | 4 |
| [memory](#35-记忆-memory) | 持久化记忆的读写、召回、整合 | 6 |
| [jobs](#36-任务调度-jobs) | 后台命令、cron 定时任务、autodream 调度 | 4 |
| [workflow](#37-工作流-workflow) | 可编排的多步工作流执行引擎 | 6 |
| [compaction](#38-上下文压缩-compaction) | 上下文压缩（多级策略） | 2 |
| [tools](#39-内置工具-tools--process) | 内置工具（bash/文件/glob）实现与注册 | 5 |
| [process](#39-内置工具-tools--process) | 进程输出收集与进程树终止 | 2 |
| [providers](#310-模型提供者-providers) | LLM 提供商适配器（Anthropic/OpenAI 兼容） | 5 |
| [extensions](#311-扩展-extensions) | 技能加载 + MCP 协议接入 | 5 |
| [security](#312-安全-security) | 权限审批与危险命令检测 | 2 |
| [session](#313-会话-session) | 会话历史 JSONL 落盘 | 1 |
| [tracing](#314-追踪-tracing) | 用量追踪、成本计算、trace 查询 | 6 |
| [config](#315-配置-config) | 配置发现、合并、校验、持久化 | 3 |

---

## 三、分层与逐文件详解

### 3.1 入口层 `cli`

程序的启动与交互入口，负责把一切子系统装配起来。

| 文件 | 作用 |
|---|---|
| `main.ts` | 程序入口：解析命令行参数，分发到 `blh web` / `blh -p`（一次性）/ 默认 REPL 三种模式，处理 `--continue` 会话续接 |
| `repl.ts` | 交互式主循环：读输入 → 处理 `/goal` → 跑一轮 agent → 打印回复；接入 cron/autodream/团队三个后台回调，用锁串行化 |
| `web.ts` | Web 工作台启动封装：注入依赖并定位前端静态目录，交给 `@blh/web-server` 启动 |
| `buildHarness.ts` | 装配车间：按依赖顺序组装配置、provider、工具、钩子、规划、记忆、任务、压缩、团队、扩展、工作流、目标，统一塞进 `Harness`，并注册生命周期管理 |

### 3.2 运行时核心 `runtime`

agent 的核心循环与组装中枢，定义"端口-适配器"的端口层。

| 文件 | 作用 |
|---|---|
| `harness.ts` | 组合根：实现 `AgentLoopRuntime`，把依赖串起来并拼接系统提示词；提供 `runTurn`/`runScheduledTurn`/`runDreamTurn`/`runTeamTurn` 等各类回合 |
| `loop.ts` | agent 主循环：反复调模型直到不再要求工具调用，中间执行压缩、后台任务注入、工具分发、目标评估、事件广播与 token 记账 |
| `ports.ts` | 端口定义：`ToolRegistryPort`/`MemoryPort`/`JobsPort`/`AgentLoopRuntime` 等抽象接口，解耦运行时与实现 |
| `hooks.ts` | 钩子总线：`register`/`trigger`/`firstBlock`，供工具调用前后拦截与扩展 |
| `events.ts` | 事件总线：纯发布订阅，`subscribe`/`emit`，供 REPL 订阅 agent 高层事件 |
| `agent-lock.ts` | 异步互斥锁：串行化跨 `await` 的临界区（多类回合共写 messages） |
| `parse-args.ts` | 把模型传来的 JSON 参数安全解析成对象，非法则返回 `{}` |
| `security-context.ts` | 基于 `AsyncLocalStorage` 的权限上下文（scheduled / dream 轮次标记），供审批与写文件判定 |

### 3.3 契约层 `contracts`

全局共享的类型、协议与纯函数，被所有层引用、自身几乎无依赖。

| 文件 | 作用 |
|---|---|
| `types.ts` | 核心类型：`ChatMessage`/`Config`/`ToolDefinition`/`ChatProvider`/`ChatUsage` 等基础契约 |
| `events.ts` | `AgentEvent` 高层事件联合类型（turn_start/tool_call/turn_end 等） |
| `hooks.ts` | 钩子事件契约：事件常量 + 事件名→载荷映射 + `HookFn` |
| `goals.ts` | 目标命令解析（`parseGoalCommand`）与 `StopDecision` 类型 |
| `text.ts` | 文本截断工具 `summarize` |
| `provider-errors.ts` | 判定是否为"上下文超长"错误的启发式函数 `isPromptTooLong` |

### 3.4 多智能体协作 `agents` / `planning` / `goals`

#### `agents`（团队协作执行层）

| 文件 | 作用 |
|---|---|
| `bus.ts` | 基于文件收件箱的消息总线，agent 间 JSONL 收发消息 |
| `subagent.ts` | 一次性子智能体运行器（`task` 工具的底层实现） |
| `team.ts` | 团队运行时协调器：管理队友 spawn/关闭、任务认领、计划审批门、后台轮询 |
| `teammate.ts` | 单个常驻队友的运行器：构造提示词、处理收件箱、空闲自动认领任务 |
| `tools.ts` | 注册 `task`/`spawn_teammate`/`send_message`/`review_plan` 等团队工具 |
| `worktree.ts` | git worktree 生命周期管理（隔离工作目录的创建/删除与安全校验） |

#### `planning`（任务与待办）

| 文件 | 作用 |
|---|---|
| `tasks.ts` | `TaskStore`：任务持久化 + 依赖图（环检测、认领、完成） |
| `todo.ts` | `TodoManager`：会话级待办清单（最多 20 条），连续多轮未用则提醒 |
| `tools.ts` | 注册 `todo_write`/`create_task`/`list_tasks`/`claim_task` 等规划工具 |

#### `goals`（目标达成判定）

| 文件 | 作用 |
|---|---|
| `controller.ts` | `GoalController`：目标生命周期 + 每轮结束后判定继续/达成/失败 |
| `evaluator.ts` | 用模型单轮判断目标完成条件是否满足（严格解析 JSON） |
| `transcript.ts` | 把消息序列渲染成文本，供评估器喂给模型 |
| `types.ts` | goals 模块的共享类型 |

### 3.5 记忆 `memory`

持久化记忆的读、写、整合。

| 文件 | 作用 |
|---|---|
| `system.ts` | `Memory` 门面：对外暴露 `systemSection`/`extract`/`consolidate` 三个统一入口 |
| `recall.ts` | 读记忆：召回相关记忆并拼成注入系统提示的背景文本 |
| `extract.ts` | 写记忆：从对话提取长期知识 + 合并去重 |
| `dream.ts` | `MemoryDream`：定期 autodream 整理，快照/回滚 + 删除清单执行 |
| `store.ts` | 记忆文件与 `MEMORY.md` 索引的底层读写、frontmatter 解析、路径安全 |
| `text.ts` | 取消息纯文本、提取 JSON 数组两个纯函数 |

### 3.6 任务调度 `jobs`

后台命令、cron 定时任务、autodream 的调度。

| 文件 | 作用 |
|---|---|
| `background.ts` | 后台异步执行慢 bash 命令，后续回合以通知形式收集结果 |
| `cron.ts` | 五段式 cron 解析 + `CronScheduler`（调度、持久化、at-least-once 确认） |
| `runtime.ts` | `JobsRuntime`：编排后台/cron/dream 的轮询调度、互斥锁、退避重试 |
| `tools.ts` | 注册 `schedule_cron`/`list_crons`/`cancel_cron` 工具 |

### 3.7 工作流 `workflow`

可编排的多步工作流执行引擎。

| 文件 | 作用 |
|---|---|
| `runtime.ts` | 工作流执行引擎：`ExecutionState` 提供 agent/parallel/pipeline/phase 等编排原语 |
| `tool.ts` | `WorkflowTool` + `runWorkflow`：校验、加锁执行、写快照、支持断点续跑 |
| `registry.ts` | 内置工作流定义（硬编码 `review-changes` 示例编排） |
| `journal.ts` | append-only jsonl 运行日志 + 结果缓存 + resume 回放 |
| `schema.ts` | 稳定 hash、确定性序列化、JSON 校验、runner 输出解析 |
| `tools.ts` | 注册 `run_workflow` 工具 |

### 3.8 上下文压缩 `compaction`

控制上下文长度，按成本从低到高多级压缩。

| 文件 | 作用 |
|---|---|
| `compactor.ts` | `ContextCompactor`：多级压缩策略（挪工具结果 → 砍中间 → 模型摘要） |
| `compactTool.ts` | 把 `compact` 注册为模型可主动调用的工具 |

### 3.9 内置工具 `tools` / `process`

#### `tools`（工具实现与注册）

| 文件 | 作用 |
|---|---|
| `bash.ts` | `bash` 工具实现：spawn 子进程执行命令，超时/取消/输出截断 |
| `files.ts` | `read_file`/`write_file`/`edit_file` 实现，含路径逃逸与 symlink 防护 |
| `glob.ts` | `glob` 工具实现：fnmatch 语义转正则 + 目录遍历 |
| `registry.ts` | `ToolRegistry`：工具的注册/注销/分发，统一异常包装 |
| `index.ts` | 内置工具注册入口，绑定 config 参数到 handler |

#### `process`（进程底层支撑）

| 文件 | 作用 |
|---|---|
| `output.ts` | `BoundedOutputCollector` 有界输出收集 + 截断格式化 + 超时校验 |
| `terminate.ts` | `terminateProcessTree`：跨平台终止子进程及整棵进程树 |

### 3.10 模型提供者 `providers`

对接外部 LLM API 的适配器。

| 文件 | 作用 |
|---|---|
| `catalog.ts` | 内置 provider 描述表（deepseek/anthropic/qwen/kimi）+ 自动检测 |
| `anthropic.ts` | `AnthropicProvider`：对接 Anthropic Messages API |
| `openai-compat.ts` | `OpenAICompatProvider`：对接 OpenAI 兼容协议（DeepSeek/Qwen/Kimi） |
| `registry.ts` | `createProvider` 工厂：按配置实例化对应 provider、解析 apiKey |
| `retry.ts` | 请求重试工具集（指数退避、`Retry-After` 解析、可重试判定） |

### 3.11 扩展 `extensions`

技能加载 + MCP 协议接入。

| 文件 | 作用 |
|---|---|
| `index.ts` | `Extensions` 门面：把技能目录与 MCP 说明拼成系统提示片段 |
| `mcp-transport.ts` | MCP 底层传输：`StdioTransport` 与 `HttpTransport` |
| `mcp.ts` | `MCPClient` 协议层 + `MCPRegistry`（多服务器工具注册、冲突回滚） |
| `skills.ts` | `SkillLoader`：扫描 `SKILL.md` 并解析 frontmatter |
| `tools.ts` | 注册 `load_skill`/`connect_mcp` 工具 |

### 3.12 安全 `security`

| 文件 | 作用 |
|---|---|
| `approval.ts` | `makePermissionHook`：工具执行前的权限决策与审批流（白名单/规则/询问） |
| `rules.ts` | 权限规则引擎 + 危险命令静态检测（rm -rf、强制推送等） |

### 3.13 会话 `session`

| 文件 | 作用 |
|---|---|
| `store.ts` | `SessionStore`：`.sessions/` 下 JSONL 会话文件的唯一读写入口 |

### 3.14 追踪 `tracing`

| 文件 | 作用 |
|---|---|
| `tracer.ts` | `Tracer`：追加式 JSONL 追踪器（写 `.blh/traces/`，计算成本） |
| `store.ts` | `TraceStore`：trace 数据读取层（增量 tail、缓存、聚合） |
| `module.ts` | `createTraceModule`：对外查询门面（overview/turns/events） |
| `fold.ts` | 把平铺事件折叠成结构化轮次视图 |
| `pricing.ts` | 模型计费单价表 + 用量聚合 |
| `types.ts` | trace 模块共享类型 |

### 3.15 配置 `config`

| 文件 | 作用 |
|---|---|
| `config.ts` | `loadConfig`：CLI > 环境变量 > 项目 config > 用户 settings > 默认值 的优先级合并 |
| `env.ts` | 读取环境变量（空串视为未设置） |
| `settings.ts` | 用户级设置持久化（`~/.blh/settings.json`） |

---

## 四、一次对话的完整数据流

```
用户输入
  │
  ▼
repl.ts / main.ts  ──►  buildHarness.ts 组装出 Harness
  │
  ▼
harness.runTurn()
  ├─ hooks.trigger(USER_PROMPT_SUBMIT)
  ├─ memory.systemSection() 注入记忆背景（contracts + memory）
  └─ agentLoop()  ────────────────────────────────┐
        │  loop.ts                                  │
        ├─ compactor.prepare()  压缩上下文           │
        ├─ jobs.injectBackgroundResults()           │
        ├─ provider.chat()  调模型（providers）       │
        ├─ parse-args 解析工具参数                    │
        ├─ hooks.firstBlock(PRE_TOOL_USE) 拦截？     │
        │     ├─ 拦截 ──► 用钩子返回值作为结果         │
        │     └─ 不拦截 ──► tools.dispatch() 执行工具 │
        │           └─ hooks.trigger(POST_TOOL_USE)  │
        ├─ 广播 events（EventBus）──► REPL/前端渲染   │
        └─ 无工具调用时 ──► goal.evaluateAfterTurn()  │
              └─ 决定继续 / 结束本轮                   │
  │                                                │
  ▼                                                │
hooks.trigger(STOP)  +  memory.extract/consolidate  │
  │                                                │
  ▼                                                │
session.store.append() 落盘  +  tracer 记录用量与成本 ┘
```

---

## 五、关键设计要点

1. **端口-适配器**：`runtime/ports.ts` 定义端口，`Harness` 实现 `AgentLoopRuntime`，具体实现（memory/jobs/goals…）通过构造函数注入，核心运行时与外部解耦。
2. **契约下沉**：`contracts/` 是被 30+ 文件引用的全局词汇表，放最底层避免循环依赖；`ports.ts` 是运行时的组装接缝，两者角色不同。
3. **事件 vs 钩子**：`events.ts` 是无返回值的单向广播（供展示）；`hooks.ts` 是有返回值的拦截点（`firstBlock` 可改写工具调用，参与控制流）。
4. **依赖方向单向**：`cli → runtime → 能力/基础设施 → contracts`，无反向依赖，保证可测试性与可替换性。
