# blh

一个运行在命令行里的编码 Agent（TypeScript 版），通过 OpenAI 兼容 API 与模型交互，可调用 bash 与文件工具完成编码任务。同时内置一个基于 Web 的交互式工作台，提供会话管理、流式输出、工具调用卡片与权限审批等可视化能力。

## 特性概览

- **三种运行方式**：交互式 REPL、单次对话（`-p`）、Web 工作台（`blh web`）。
- **丰富的工具集**：5 个内置工具 + 规划、记忆、定时任务、多智能体、技能/MCP、工作流等扩展工具。
- **权限与安全**：PreToolUse 权限规则、交互审批、破坏性命令硬拦截、`--dangerously-skip-permissions`。
- **上下文管理**：上下文压缩（compaction）、计划与追踪（todo/task）、长期记忆（memory）。
- **异步与调度**：后台 bash、cron 定时任务、后台/定时任务统一运行时。
- **多智能体**：一次性 subagent、持久队友、团队协作、git worktree 隔离。
- **扩展机制**：技能按需加载（`load_skill`）、MCP 客户端（stdio 与 HTTP 传输）。
- **Web 工作台**：React 前端 + HTTP/SSE 后端，支持流式输出、工具卡片、审批弹窗、中断。

## 项目结构

这是一个 pnpm workspace monorepo，根包是 CLI（`blh`），其余为内部子包：

| 目录 | 包名 | 说明 |
|---|---|---|
| `src/` | `blh` | CLI 入口与 Agent 核心（配置、循环、工具、各子系统） |
| `packages/logger` | `@blh/logger` | 日志库（node / browser 双端） |
| `packages/web-client` | `@blh/web-client` | Web 前端与后端通信的 API/SSE 客户端 |
| `apps/web-server` | `@blh/web-server` | Web 工作台后端（HTTP + SSE 广播） |
| `apps/web` | `@blh/web` | Web 工作台前端（React + Vite） |

## 安装

要求 Node.js >= 20 与 pnpm。

```powershell
pnpm install
pnpm build
```

构建产物输出到 `dist/`，CLI 入口为 `dist/cli/main.js`（`package.json` 的 `bin` 名称为 `blh`）。Web 前端构建到 `dist/web/`（由 `pnpm build:web` 生成）。

## 快速开始

### 1. 配置 API Key

在项目根目录（或任意向上查找得到的目录）放一个 `.env`。可直接复制仓库里的 `.env.example` 为 `.env`，再填入你自己的值：

```powershell
copy .env.example .env
```

`.env` 内容示例：

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# 可选：使用兼容网关时指定
OPENAI_BASE_URL=https://api.openai.com/v1
```

也可用 YAML 配置（见下文「配置」）。

### 2. 交互式运行（REPL）

```powershell
pnpm dev
```

进入 REPL 后直接输入指令即可。支持以下内建命令：

- `exit` / `quit`：退出。
- `/goal <目标>`：设置本轮目标；`/goal status` 查看；`/goal clear` 清除。

### 3. 单次对话（`-p`）

```powershell
pnpm dev -- -p "解释 src/core/config.ts 的作用"
```

### 4. Web 工作台

开发模式（前端由 Vite dev server 提供，需另开终端启动前端）：

```powershell
# 终端 1：启动后端（dev 模式）
pnpm web:server

# 终端 2：启动前端
pnpm web:client
```

生产模式（后端直接 serve 构建后的前端，自动打开浏览器）：

```powershell
pnpm web:prod
```

`pnpm web:prod` 会依次执行 `pnpm build`、`pnpm build:web` 并以生产模式启动 Web 服务，默认监听 `http://127.0.0.1:8123`。需要改端口时用 `pnpm dev -- web --port N`。

## 运行模式

| 模式 | 命令 | 说明 |
|---|---|---|
| REPL | `blh` | 交互式循环，支持流式输出、cron、团队任务 |
| 单次对话 | `blh -p "<提示词>"` | 跑一轮即打印结果退出 |
| Web 工作台 | `blh web [--port N] [--dev]` | 启动本地 Web 工作台 |
| 继续会话 | `blh --continue [文件]` | 继续最近一次或 `.sessions/` 里的会话 |

完整 CLI 选项：

```
blh [-h] [-p 提示词] [--model 模型] [--base-url 基础地址]
    [--workdir 工作目录] [--bash-timeout 超时秒数]
    [--max-output-chars 最大输出字符数]
    [--dangerously-skip-permissions] [--continue [文件]]

blh web [--port N] [--dev] [--workdir 目录]
```

## 配置

配置按「低优先级在前、高优先级在后」合成，最终取最高优先级命中的值：

```
内置默认 < 配置文件 < 环境变量 < CLI 参数
```

| 键 | 环境变量 | CLI 参数 | 默认值 |
|---|---|---|---|
| `api_key` | `OPENAI_API_KEY` | — | 无（缺失则退出） |
| `base_url` | `OPENAI_BASE_URL` | `--base-url` | 无 |
| `model` | `OPENAI_MODEL` | `--model` | `gpt-4o-mini` |
| `workdir` | — | `--workdir` | 当前目录 |
| `bash_timeout` | `BLH_BASH_TIMEOUT` | `--bash-timeout` | `120` |
| `max_output_chars` | `BLH_MAX_OUTPUT_CHARS` | `--max-output-chars` | `30000` |
| `mcp_servers` | — | — | 空（仅配置文件） |

日志级别可通过环境变量 `BLH_LOG_LEVEL` 控制（`debug` / `info` / `warn` / `error`），日志文件写入工作目录下的 `.blh/logs/`。

### 配置文件

- 用户级：`~/.config/blh/config.yaml`
- 项目级：`.blh.yaml`（从当前目录向上查找第一个）

两个文件均存在时，用户级先读、项目级后读，后读覆盖先读。YAML 使用 snake_case 键名：

```yaml
api_key: sk-...
base_url: https://api.openai.com/v1
model: gpt-4o-mini
workdir: .
bash_timeout: 120
max_output_chars: 30000
```

CLI 参数同样映射到上述键，优先级最高：

```powershell
pnpm dev -- --model deepseek-chat --base-url https://example.com/v1
```

### MCP 服务器

`mcp_servers` 只能写在配置文件里（结构复杂，不适合用环境变量或命令行传）。每项二选一：本地 stdio（`command` + `args`）或远程 HTTP（`url` + `headers`），启动时会自动后台连接：

```yaml
mcp_servers:
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

## 工具清单

### 内置工具

| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell 命令，支持 `run_in_background` 参数转后台运行 |
| `read_file` | 带行号读取文件 |
| `write_file` | 写入文件（自动创建父目录） |
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

## 权限与安全

- 每个工具调用前经 PreToolUse 权限钩子校验，按规则放行、拒绝或询问用户。
- Web 工作台对非破坏性 bash 命令默认放行，破坏性命令仍由硬规则拦截。
- `--dangerously-skip-permissions` 跳过除硬性禁止规则外的所有检查。
- Web 后端仅监听回环地址（`127.0.0.1`），并校验 Host 头防 DNS rebinding；状态变更类请求要求携带 `x-blh-web` 头防 CSRF。

## Web 工作台

后端提供 HTTP API 与 SSE 事件流（`/api/events`），前端由 React 构建。

主要接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/session` | 当前会话 |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/:file` | 加载指定会话 |
| POST | `/api/session/new` | 新建会话 |
| POST | `/api/session/resume` | 恢复会话 |
| POST | `/api/session/delete` | 删除会话 |
| POST | `/api/message` | 发送消息（异步 202） |
| POST | `/api/stop` | 中断当前运行 |
| POST | `/api/approval` | 回复权限审批 |
| POST | `/api/log` | 接收前端日志 |
| GET | `/api/events` | SSE 事件流 |

前端主要能力：会话侧边栏、消息/工具调用卡片、流式输出、思考面板、权限审批弹窗、错误横幅、中断按钮。

## 里程碑

- **M0 基础**：REPL / `-p` 单次对话，5 个内置工具，PreToolUse 权限规则，429/5xx 自动重试。
- **M1 上下文**：上下文压缩（compaction）、计划与追踪（planning）、长期记忆（memory）。
- **M2 异步与调度**：后台 bash 任务、cron 调度（`schedule_cron`/`list_crons`/`cancel_cron`）。
- **M3 多智能体**：一次性 subagent（`task`）、文件收件箱、git worktree、持久队友与团队工具。
- **M4 扩展**：技能按需加载（`load_skill`）、MCP 客户端与多连接注册（`connect_mcp`），支持 stdio 与 HTTP 传输。
- **M5 编排与目标闭环**：`run_workflow` 内置工作流（journal 断点恢复）、session 级目标闭环（`/goal`）。
- **M6 打磨与发布**：四层配置、CLI 参数解析、Retry-After 与退避抖动。
- **M7 Web 工作台**：React 前端 + HTTP/SSE 后端、流式输出、工具卡片、审批弹窗、会话管理、中断。

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 用 tsx 运行 CLI（REPL） |
| `pnpm dev:yes` | 跳过权限运行 CLI |
| `pnpm web:server` | 以 dev 模式启动 Web 后端 |
| `pnpm web:client` | 启动 Web 前端（Vite dev server） |
| `pnpm build` | tsc 构建 CLI 到 `dist/` |
| `pnpm build:web` | 构建 Web 前端到 `dist/web/` |
| `pnpm web:prod` | 构建 CLI + 前端并启动 Web 工作台（生产模式） |
| `pnpm typecheck` | 类型检查（不产出） |
| `pnpm test` | 运行 vitest 全量测试 |
| `pnpm lint` | ESLint 检查 |
