# blh

> 一个用 TypeScript 从零实现的类 Claude Code 终端编码 Agent：通过 OpenAI 兼容 API 驱动，内置 20+ 工具、完整的权限体系与上下文管理，并附带一个 React + SSE 的 Web 工作台。
>
> A Claude Code-style terminal coding agent written from scratch in TypeScript, featuring 20+ built-in tools, a pluggable permission system, context compaction, multi-agent collaboration, cron scheduling, MCP support, and a React + SSE web workbench.

**5 个内置工具 · 20+ 扩展工具 · 8 个迭代里程碑(M0-M7)· CLI / 单次对话 / Web 工作台三种运行模式 · pnpm workspace monorepo**

---

## 项目亮点

| 模块 | 设计点 |
|---|---|
| **Agent 内核** | 自研 ReAct 主循环与工具调用协议,429/5xx 自动重试 + Retry-After 退避抖动,不依赖任何现成 Agent 框架 |
| **权限与安全** | PreToolUse 权限钩子按规则放行/拒绝/询问,破坏性命令硬拦截;Web 后端仅监听回环地址,Host 头校验防 DNS rebinding、自定义头防 CSRF |
| **上下文工程** | 上下文压缩(compaction)、滚动摘要、计划与追踪(todo/task)、长期记忆(memory)、session 级目标闭环(`/goal`) |
| **异步与调度** | 后台 bash、cron 定时任务,后台/定时任务由统一运行时管理生命周期 |
| **多智能体** | 一次性 subagent、持久队友、团队消息总线、git worktree 隔离并行开发 |
| **SWE-bench 评测** | 内置 SWE-bench 生成阶段 runner(`scripts/swebench-run.ts`),输出 patch 对接官方评测流程 |
| **Web 工作台** | React 前端 + HTTP/SSE 后端:会话管理、流式输出、工具调用卡片、权限审批弹窗、运行中断 |


## 特性概览

- **三种运行方式**:交互式 REPL、单次对话(`-p`)、Web 工作台(`blh web`)。
- **丰富的工具集**:5 个内置工具 + 规划、记忆、定时任务、多智能体、技能/MCP、工作流等扩展工具(见下表)。
- **权限与安全**:PreToolUse 权限规则、交互审批、破坏性命令硬拦截、`--dangerously-skip-permissions`。
- **上下文管理**:上下文压缩(compaction)、计划与追踪(todo/task)、长期记忆(memory)。
- **异步与调度**:后台 bash、cron 定时任务、后台/定时任务统一运行时。
- **多智能体**:一次性 subagent、持久队友、团队协作、git worktree 隔离。
- **扩展机制**:技能按需加载(`load_skill`)、MCP 客户端(stdio 与 HTTP 传输)。
- **Web 工作台**:React 前端 + HTTP/SSE 后端,支持流式输出、工具卡片、审批弹窗、中断。

## 快速开始

要求 Node.js >= 20 与 pnpm。

```powershell
pnpm install
pnpm build
```

### 1. 配置 API Key

在项目根目录(或任意向上查找得到的目录)放一个 `.env`。可直接复制仓库里的 `.env.example` 为 `.env`,再填入你自己的值:

```powershell
copy .env.example .env
```

```dotenv
DEEPSEEK_API_KEY=sk-...
# 或改用其他厂商:ANTHROPIC_API_KEY / DASHSCOPE_API_KEY / MOONSHOT_API_KEY
```

也可用 YAML 配置(见下文「配置」)。

### 2. 交互式运行(REPL)

```powershell
pnpm dev
```

进入 REPL 后直接输入指令即可。支持以下内建命令:

- `exit` / `quit`:退出。
- `/goal <目标>`:设置本轮目标;`/goal status` 查看;`/goal clear` 清除。

### 3. 单次对话(`-p`)

```powershell
pnpm dev -- -p "解释 src/core/config.ts 的作用"
```

### 4. Web 工作台

开发模式(前端由 Vite dev server 提供,需另开终端启动前端):

```powershell
# 终端 1:启动后端(dev 模式)
pnpm web:server

# 终端 2:启动前端
pnpm web:client
```

生产模式(后端直接 serve 构建后的前端,自动打开浏览器):

```powershell
pnpm web:prod
```

`pnpm web:prod` 会依次执行 `pnpm build`、`pnpm build:web` 并以生产模式启动 Web 服务,默认监听 `http://127.0.0.1:8123`。需要改端口时用 `pnpm dev -- web --port N`。

### 5. SWE-bench 评测

仓库内置 SWE-bench 生成阶段 runner:对每个 instance 把仓库 checkout 到 base_commit、跑一轮 blh、提取 patch 到 `predictions/`,之后用官方 `swebench` 库打分:

```powershell
pnpm exec tsx scripts/swebench-run.ts --dataset <data.jsonl> --repos <仓库根目录> [--limit N]
```

## 运行模式

| 模式 | 命令 | 说明 |
|---|---|---|
| REPL | `blh` | 交互式循环,支持流式输出、cron、团队任务 |
| 单次对话 | `blh -p "<提示词>"` | 跑一轮即打印结果退出 |
| Web 工作台 | `blh web [--port N] [--dev]` | 启动本地 Web 工作台 |
| 继续会话 | `blh --continue [文件]` | 继续最近一次或 `.sessions/` 里的会话 |

完整 CLI 选项:

```
blh [-h] [-p 提示词] [--provider 厂商] [--model 模型] [--base-url 基础地址]
    [--workdir 工作目录] [--bash-timeout 超时秒数]
    [--max-output-chars 最大输出字符数]
    [--dangerously-skip-permissions] [--continue [文件]]

blh web [--port N] [--dev] [--workdir 目录]
```

## 工具清单

### 内置工具

| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell 命令,支持 `run_in_background` 参数转后台运行 |
| `read_file` | 带行号读取文件 |
| `write_file` | 写入文件(自动创建父目录) |
| `edit_file` | 用唯一匹配替换文件内容 |
| `glob` | 按 glob 模式查找文件 |

### 扩展工具

| 分组 | 工具 |
|---|---|
| 规划 | `todo_write`、`create_task`、`update_task`、`list_tasks`、`get_task`、`claim_task`、`complete_task` |
| 上下文压缩 | `compact` |
| 定时任务 | `schedule_cron`、`list_crons`、`cancel_cron` |
| 多智能体 | `task`、`spawn_teammate`、`list_teammates`、`send_message`、`request_shutdown`、`request_plan`、`review_plan`、`create_worktree` |
| 扩展 | `load_skill`、`connect_mcp` |
| 工作流 | `run_workflow` |

## 配置

配置按「低优先级在前、高优先级在后」合成,最终取最高优先级命中的值:

```
内置默认 < 配置文件 < 环境变量 < CLI 参数
```

| 键 | 环境变量 | CLI 参数 | 默认值 |
|---|---|---|---|
| `provider` | `BLH_PROVIDER` | `--provider` | `deepseek`(无显式时自动检测第一个有 key 的厂商) |
| `api_key` | (见厂商 key) | — | 无(缺失则退出) |
| `base_url` | `OPENAI_BASE_URL` | `--base-url` | 厂商默认 |
| `model` | `OPENAI_MODEL` | `--model` | 厂商 defaultModel(deepseek-chat) |
| `workdir` | — | `--workdir` | 当前目录 |
| `bash_timeout` | `BLH_BASH_TIMEOUT` | `--bash-timeout` | `120` |
| `max_output_chars` | `BLH_MAX_OUTPUT_CHARS` | `--max-output-chars` | `30000` |

日志级别可通过环境变量 `BLH_LOG_LEVEL` 控制(`debug` / `info` / `warn` / `error`),日志文件写入工作目录下的 `.blh/logs/`。

### 配置文件

- 用户级:`~/.blh/config.yaml`
- 项目级:`.blh/config.yaml`(从当前目录向上查找第一个)

两个文件均存在时,用户级先读、项目级后读,后读覆盖先读。YAML 使用 snake_case 键名:

```yaml
provider: deepseek
api_key: sk-...
base_url: https://api.deepseek.com
model: deepseek-chat
```

MCP 服务器单独写在 `mcp.yaml`(见下节),不放 `config.yaml`。

CLI 参数同样映射至上述键,优先级最高:

```powershell
pnpm dev -- --provider deepseek --model deepseek-chat
```

### MCP 服务器

`mcp_servers` 拆分到独立的 `.blh/mcp.yaml`(全局 `~/.blh/mcp.yaml`)。顶层是数组,每项二选一:本地 stdio(`command` + `args`)或远程 HTTP(`url` + `headers`),启动时会自动后台连接:

```yaml
# 本地 stdio
- name: weather
  command: npx
  args: ["-y", "@dangahagan/weather-mcp@latest"]

# 远程 HTTP
- name: web-search
  url: https://example.com/mcp
  headers:
    Authorization: "Bearer ..."
```

## 权限与安全

- 每个工具调用前经 PreToolUse 权限钩子校验,按规则放行、拒绝或询问用户。
- Web 工作台对非破坏性 bash 命令默认放行,破坏性命令仍由硬规则拦截。
- `--dangerously-skip-permissions` 跳过除硬性禁止规则外的所有检查。
- Web 后端仅监听回环地址(`127.0.0.1`),并校验 Host 头防 DNS rebinding;状态变更类请求要求携带 `x-blh-web` 头防 CSRF。

## 工程实践

这个项目不只是「能跑」,开发过程留了一套可复盘的工程记录(见 `docs/`):

- `docs/2026-09-15-blh-claude-code-ts-design.md` — 总体设计文档
- `docs/2026-09-18-code-review.md` — 代码评审记录
- `docs/debugging-methodology.md` — 调试方法论沉淀
- `docs/boundary-checklist.md` — 边界问题清单:加任何功能前必过的"防无限膨胀"检查项
- `docs/plans/` — 按里程碑拆分的实施计划

## Web 工作台

后端提供 HTTP API 与 SSE 事件流(`/api/events`),前端由 React 构建。

主要接口:

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/session` | 当前会话 |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/:file` | 加载指定会话 |
| POST | `/api/session/new` | 新建会话 |
| POST | `/api/session/resume` | 恢复会话 |
| POST | `/api/session/delete` | 删除会话 |
| POST | `/api/message` | 发送消息(异步 202) |
| POST | `/api/stop` | 中断当前运行 |
| POST | `/api/approval` | 回复权限审批 |
| POST | `/api/log` | 接收前端日志 |
| GET | `/api/events` | SSE 事件流 |

前端主要能力:会话侧边栏、消息/工具调用卡片、流式输出、思考面板、权限审批弹窗、错误横幅、中断按钮。

## 项目结构

这是一个 pnpm workspace monorepo,根包是 CLI(`blh`),其余为内部子包:

| 目录 | 包名 | 说明 |
|---|---|---|
| `src/` | `blh` | CLI 入口与 Agent 核心,按子系统划分:`agents`(多智能体/消息总线/worktree)、`compaction`(上下文压缩)、`core`(主循环)、`extensions`(技能/MCP)、`goals`(目标闭环)、`jobs`(后台任务)、`memory`(长期记忆)、`planning`(计划追踪)、`providers`(模型接入)、`security`(权限规则/审批)、`session`(会话)、`tools`(工具注册)、`workflow`(工作流运行时) |
| `packages/logger` | `@blh/logger` | 日志库(node / browser 双端) |
| `packages/web-client` | `@blh/web-client` | Web 前端与后端通信的 API/SSE 客户端 |
| `apps/web-server` | `@blh/web-server` | Web 工作台后端(HTTP + SSE 广播) |
| `apps/web` | `@blh/web` | Web 工作台前端(React + Vite) |
| `scripts/swebench-run.ts` | — | SWE-bench 生成阶段评测 runner |
| `docs/` | — | 设计文档、评审记录、调试方法论与里程碑计划 |

## 里程碑

- **M0 基础**:REPL / `-p` 单次对话,5 个内置工具,PreToolUse 权限规则,429/5xx 自动重试。
- **M1 上下文**:上下文压缩(compaction)、计划与追踪(planning)、长期记忆(memory)。
- **M2 异步与调度**:后台 bash 任务、cron 调度(`schedule_cron`/`list_crons`/`cancel_cron`)。
- **M3 多智能体**:一次性 subagent(`task`)、文件收件箱、git worktree、持久队友与团队工具。
- **M4 扩展**:技能按需加载(`load_skill`)、MCP 客户端与多连接注册(`connect_mcp`),支持 stdio 与 HTTP 传输。
- **M5 编排与目标闭环**:`run_workflow` 内置工作流(journal 断点恢复)、session 级目标闭环(`/goal`)。
- **M6 打磨与发布**:四层配置、CLI 参数解析、Retry-After 与退避抖动。
- **M7 Web 工作台**:React 前端 + HTTP/SSE 后端、流式输出、工具卡片、审批弹窗、会话管理、中断。

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 用 tsx 运行 CLI(REPL) |
| `pnpm dev:yes` | 跳过权限运行 CLI |
| `pnpm web:server` | 以 dev 模式启动 Web 后端 |
| `pnpm web:client` | 启动 Web 前端(Vite dev server) |
| `pnpm build` | tsc 构建 CLI 到 `dist/` |
| `pnpm build:web` | 构建 Web 前端到 `dist/web/` |
| `pnpm web:prod` | 构建 CLI + 前端并启动 Web 工作台(生产模式) |
| `pnpm typecheck` | 类型检查(不产出) |
| `pnpm test` | 运行 vitest 全量测试 |
| `pnpm lint` | ESLint 检查 |
