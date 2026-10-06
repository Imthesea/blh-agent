# pi 设计借鉴点未来规划（Backlog）

> 对比对象：`re-pi/packages/coding-agent`（下文简称 **pi**）与本项目 `blh`（根包 `src/` + `apps/` + `packages/`）。
> 本文件只是把 pi 中「值得借鉴、可移植到 blh」的点整理成 backlog，供逐项评审后决定实现顺序；本文件不直接改代码。
> 生成日期：2026-10-06。

## 一、背景与目标

- 已经通读双方 `src` 结构：pi 是单一 `AgentSession` 核心 + 三种运行模式（interactive/print/rpc）共享会话、扩展面很全；blh 是端口化（ports/DI）+ 事件溯源 Transcript + HookBus + MCP，并具备 pi 没有的高级能力（multi-agent team/subagent/worktree、memory dream、tracing+pricing、workflow、goals、jobs/cron、Web 前端）。
- 结论：**blh 的底层架构不输 pi**（甚至 ports/事件溯源/hook 阻断语义更清晰），真正值得借鉴的是 pi 的「生产成熟度、可扩展面、可观测性、可运维性」这些工程化细节。
- 目标：把 pi 的可借鉴点拆成**可独立评审、可独立验收、可独立回滚**的小条目，形成 backlog；由用户逐项对比后决定先做哪个。

## 二、对比结论摘要（一句话版）

| 维度 | pi 强于 blh | blh 强于 pi |
|---|---|---|
| 核心抽象 | `AgentSession` 三种模式共享，会话切换有统一骨架 | ports/DI + 事件溯源 Transcript，边界更干净 |
| 扩展性 | 富扩展 API（typed events、自定义工具/slash command、markdown 转换、UI widget） | HookBus 的 `firstBlock` 阻断语义更清晰 |
| 可观测性 | 统一 diagnostics、启动打点、迁移、changelog/自更新 | tracing+pricing 仪表盘 |
| 健壮性 | proper-lockfile、skills 规范校验、错误 cause 链解包 | provider 重试（Retry-After + 退避 + abort 不重试）、破坏性命令检测更全 |
| 功能面 | 会话导出/分享、模型解析诊断、主题系统、内置工具自动下载 | team/subagent/worktree、memory dream、workflow、goals、jobs/cron |

借鉴重点是**「把现有模块做扎实」**，不是推倒架构。

## 三、借鉴点总览表

| 编号 | 类别 | 借鉴点 | 优先级 | 预估成本 | 前置依赖 |
|---|---|---|---|---|---|
| B1 | 可观测性 | 统一 diagnostics（warning/error/collision + 去重 + 一次上报） | P0 | 中 | 无 |
| B2 | 可运维性 | 一次性迁移框架（幂等、带 guard） | P0 | 小 | 无 |
| B3 | 会话 | 会话条目版本化 + `custom`/`label`/`session_info` 预留 | P0 | 小 | B2 |
| B4 | 运行时 | EventBus channel 化 + 每 handler 错误隔离 + `clear()` | P0 | 小 | 无 |
| B5 | 扩展 | SkillLoader 补齐规范校验 + ignore 文件 + `disable-model-invocation` | P1 | 小 | 无 |
| B6 | 扩展 | hook 载荷按工具强类型化（`pre_tool_use` 细分） | P1 | 中 | 无 |
| B7 | 工具 | 工具输出统一截断 + 路径规范化/越界校验 | P1 | 小 | 无 |
| B8 | 会话 | 会话切换「工厂闭包」骨架（`/resume` `/new` `/fork`） | P1 | 大 | B3 |
| B9 | 扩展 | 富扩展 API：自定义 slash command、`defineTool`/`wrapRegisteredTools`、markdown 转换 | P1 | 大 | B4/B6 |
| B10 | 可观测性 | 启动耗时埋点（timings + `BLH_STARTUP_BENCHMARK`） | P2 | 小 | 无 |
| B11 | 健壮性 | 会话/配置写入文件锁（并发写保护） | P2 | 中 | 无 |
| B12 | 安全 | 项目信任持久化（trust 文件记住 allow 决定） | P2 | 中 | 无 |
| B13 | 健壮性 | 错误 `cause` 链解包（深度上限） | P2 | 小 | 无 |
| B14 | 分发 | changelog 提示 + 版本检查（含 `lastChangelogVersion`） | P2 | 中 | 无 |
| B15 | 工具 | 内置工具探测→下载→降级提示（fd/rg） | P2 | 大 | 无 |
| B16 | 会话 | 会话导出 HTML/JSONL + 分享 | P2 | 大 | B3 |
| B17 | 模型 | 模型解析带诊断 + 远程 catalog 刷新 | P2 | 大 | B1 |
| B18 | 文档 | 复杂模块同目录设计说明（.md 旁置） | P2 | 小 | 无 |

## 四、详细条目

### P0 —— 高优先（小成本、大收益）

#### B1 统一 diagnostics 系统
- **pi 来源**：`core/diagnostics.ts`（`ResourceDiagnostic { type: "warning"|"error"|"collision", message, path?, collision? }`）、`core/resource-loader.ts`、`core/model-resolver.ts`，主流程 `deduplicateDiagnostics` + `reportDiagnostics`。
- **blh 现状**：`src/config/config.ts` 内联 `throw new ConfigError(...)`，MCP/skills 加载各自 `log.warn`，没有聚合层；配置错误要么直接崩溃、要么散落日志。
- **建议**：新增 `src/contracts/diagnostics.ts`（或 `src/diagnostics/`），让 config、providers、extensions、tools 的加载/解析都返回/追加诊断对象，而非直接 throw；`cli/main.ts` 与 `buildHarness.ts` 在启动末段统一汇总上报（非交互打 stderr，web 走日志）。
- **验收**：① 配置错误能一次性列出全部问题而非首个即抛；② `warning` 不阻断、`error` 阻断；③ 重复诊断被去重。
- **收益**：CLI 与 web 的启动报错体验一致化，后续 B17 也复用。

#### B2 一次性迁移框架
- **pi 来源**：`migrations.ts`（如 `migrateAuthToAuthJson`、`migrateSessionsFromAgentRoot`），每步检查「目标已存在即跳过」，旧文件改名 `.migrated`。
- **blh 现状**：有 `.tasks`/`.memory`/`.transcripts`/`.sessions`/`.blh` 等运行目录，无任何迁移机制，版本升级时旧布局无法平滑演进。
- **建议**：新增 `src/migrations.ts`，按版本号注册幂等迁移，`cli/main.ts` 启动早期串行执行；迁移结果（迁移了哪项）打进日志。
- **验收**：① 重复启动不重复迁移；② 迁移失败不阻断主流程（记录 warning）；③ 单元测试覆盖「已迁移则跳过」。
- **收益**：B3、后续任何存储布局调整都有安全落地路径。

#### B3 会话条目版本化 + 扩展自定义条目
- **pi 来源**：`core/session-manager.ts` 的 `SessionHeader { version, id, parentSession }` + `CURRENT_SESSION_VERSION`；entry 含 `id/parentId`，并预留 `session_info`（显示名）、`label`（书签）、`custom`（扩展私有状态，不进 LLM 上下文）、`custom_message`（扩展注入上下文）。
- **blh 现状**：`src/session/transcript.ts` 已是事件溯源（append/compact/rollbackTo/cancelMessage + projection），但 `SessionEvent` 无版本号、无 `parentId`/树结构，无扩展自定义事件，无会话显示名。
- **建议**：给 `SessionEvent` 增加会话头（版本、id、cwd、可选 parent/name）；预留 `custom` 类型事件（扩展态持久化）和 `label`/`session_info`。保持现有 `Transcript` projection 不变，只扩展事件类型。
- **验收**：① 旧会话文件无版本号时按 v1 兼容读取；② 新事件类型不参与 LLM 上下文（仅 `custom_message` 参与）；③ 扩展可写读自己的 `custom` 状态。
- **收益**：为 MCP/skills 扩展提供持久化通道，为 B8/B16 的 fork/导出打底。

#### B4 EventBus channel 化 + 错误隔离 + clear()
- **pi 来源**：`core/event-bus.ts` 的 `createEventBus`：`on(channel, handler)`、每个 handler try/catch 包裹、返回 unsubscribe、`clear()`。
- **blh 现状**：`src/runtime/events.ts` 的 `EventBus` 是单事件类型 `AgentEvent` 的 `subscribe/emit`，已做 try/catch，但无 channel 分主题、无 `clear()`，扩展要订阅某类事件只能在统一回调里 `switch`。
- **建议**：小改 `EventBus`：支持按 `event.type` 过滤订阅（或 channel 化），并加 `clear()`；保持现有 `emit` 语义不变。
- **验收**：① 可按主题订阅；② 单 handler 异常不影响其他 handler；③ `clear()` 后无遗留监听。
- **收益**：web 前端与 MCP 扩展按主题订阅更省心。

### P1 —— 中优先（收益明显，成本中等）

#### B5 SkillLoader 补齐规范校验
- **pi 来源**：`core/skills.ts` 的 `validateName`/`validateDescription`（小写/连字符/长度）、读 `.gitignore/.ignore/.fdignore`、frontmatter 的 `disable-model-invocation`。
- **blh 现状**：`src/extensions/skills.ts` 只有 frontmatter 解析 + 目录扫描，无名称校验、无 ignore、无 `disable-model-invocation`。
- **建议**：把名称/描述校验与 ignore 文件读取搬进 `SkillLoader`，违规 skill 记为 warning 而非静默忽略。
- **验收**：非法 name/description 被诊断并列出；`.gitignore` 生效。
- **收益**：尽早暴露非法 skill，减少运行时困惑。

#### B6 hook 载荷按工具强类型化
- **pi 来源**：`core/extensions/types.ts` 为每个内置工具定义 `ReadToolCallEvent/BashToolCallEvent/EditToolCallEvent…`，before/after 可拿到结构化的工具参数。
- **blh 现状**：`src/contracts/hooks.ts` 的 `PRE_TOOL_USE` 载荷是 `{ name: string; input: Record<string, unknown> }`，按名字串分发，无每工具类型。
- **建议**：把 `pre_tool_use/post_tool_use` 的 `input` 细化为按工具名分派的联合类型（bash/read_file/write_file/edit_file/glob 各自定义载荷），保留 `firstBlock` 阻断语义。
- **验收**：hook 回调能拿到强类型工具参数；类型不匹配在编译期暴露。
- **收益**：扩展编写更安全，后续 B9 复用。

#### B7 工具输出统一截断 + 路径校验
- **pi 来源**：`core/tools/truncate.ts`、`core/tools/path-utils.ts`、`core/tools/output-accumulator.ts`、`core/tools/renderers/*`（定义与渲染分离）。
- **blh 现状**：工具 handler 直接返回字符串，`src/tools/index.ts` 内联定义 JSON Schema，bash/read/edit 各自处理输出长度与路径。
- **建议**：抽 `src/tools/truncate.ts`（统一按 `config.maxOutputChars` 截断）和 `src/tools/path-utils.ts`（路径规范化/越界校验），先让现有工具复用；渲染层分离可后置。
- **验收**：bash/read/edit 输出截断逻辑一致；路径越界统一报错。
- **收益**：消除重复截断逻辑，减少越界风险。

#### B8 会话切换「工厂闭包」骨架
- **pi 来源**：`core/agent-session-runtime.ts` 的 `createRuntime` 工厂（闭包进程级全局配置），switch/fork/resume 统一走「before 事件 → 准备目标 → teardown(abort→shutdown→invalidate→dispose) → apply → finish」五步。
- **blh 现状**：`src/cli/repl.ts`/`buildHarness.ts` 的新建/重放会话较内联，缺 fork/switch 骨架。
- **建议**：若要做 `/resume` `/new` `/fork`，先引入「会话运行时 + 工厂」抽象，复用统一 teardown/apply 流程；依赖 B3 的会话头。
- **验收**：会话切换/恢复不遗漏落盘与资源释放；cwd 以目标会话为准并做存在性兜底。
- **收益**：彻底消除「切换会话时顺序错误」这一类 bug。

#### B9 富扩展 API（自定义 slash command / defineTool / markdown 转换）
- **pi 来源**：`core/extensions/`（`defineTool`/`wrapRegisteredTools`、`core/slash-commands.ts`、`core/extensions/types.ts` 的 markdown transformer / UI widget / keybinding）。
- **blh 现状**：有 `HookBus` + MCP + skills，但无自定义 slash command、无 `defineTool`、无 markdown 转换钩子。
- **建议**：优先补「自定义 slash command 注册表」和「`defineTool` + 包装既有工具」；markdown 转换/UI widget 视 web 前端需要再定。依赖 B4/B6 的事件与 hook 强类型。
- **验收**：第三方可注册 slash command 与自定义工具，并接入 hook 生命周期。
- **收益**：把 blh 从「内置扩展」升级为「可编程扩展」。

### P2 —— 低优先（锦上添花 / 按需）

#### B10 启动耗时埋点
- **pi 来源**：`core/timings.ts` + `PI_STARTUP_BENCHMARK`。
- **blh 现状**：无启动打点。
- **建议**：轻量 `src/utils/timings.ts`，在 loadConfig→buildHarness→createProvider→runLoop 打点，`BLH_STARTUP_BENCHMARK=1` 开启。
- **验收**：能输出各阶段耗时，排查启动慢。

#### B11 会话/配置写入文件锁
- **pi 来源**：`proper-lockfile`（settings-manager、session 写盘）。
- **blh 现状**：`session/store.ts` 直接 append，`settings.ts` 直接写。
- **建议**：对 settings 写与 session 追加加文件锁（可自实现轻量锁或引入 `proper-lockfile`）。
- **验收**：多进程并发写不损坏。

#### B12 项目信任持久化
- **pi 来源**：`core/project-trust.ts`、`core/trust-manager.ts`。
- **blh 现状**：只有 `--dangerously-skip-permissions` 与运行时 approval rules，无「信任该目录并记住」。
- **建议**：增加 `.blh/trust.json`（或并入 rules），记录用户对某 workdir 的 allow 决定。
- **验收**：同目录重启后不再重复询问。

#### B13 错误 cause 链解包
- **pi 来源**：`utils/tools-manager.ts` 对 `error.cause` 链做深度上限 5 的解包拼接。
- **blh 现状**：工具层多为单层 `error.message`。
- **建议**：抽 `unwrapError(error, depth=5)`，在工具 dispatch 与 provider 错误上报处复用。
- **验收**：`fetch failed` 一类裸错误能带出底层 DNS/TLS 细节。

#### B14 changelog 提示 + 版本检查
- **pi 来源**：`utils/changelog.ts`（`lastChangelogVersion`）、`utils/version-check.ts`、`utils/windows-self-update.ts`、`config.ts` 的 `detectInstallMethod`。
- **blh 现状**：无版本检查、无 changelog 提示。
- **建议**：先做轻量的「记录已读 changelog 版本，首次看到新版本时提示」。
- **验收**：升级后一次性提示，不重复打扰。

#### B15 内置工具探测→下载→降级提示（fd/rg）
- **pi 来源**：`utils/tools-manager.ts`。
- **blh 现状**：`tools/glob.ts` 自实现 glob，未依赖 ripgrep。
- **建议**：仅在 glob 性能成为瓶颈时，复用 pi 的「探测→下载→降级提示」模式接入 ripgrep。
- **验收**：无 fd/rg 时给 warning 而非报错。

#### B16 会话导出 HTML/JSONL + 分享
- **pi 来源**：`core/session-export.ts`、`core/export-html/`（ansi-to-html、tool-renderer）、`modes/interactive/session-share.ts`。
- **blh 现状**：有 transcript/store，无导出/分享。
- **建议**：JSONL 导出基于事件流天然可序列化；HTML 导出参考「工具结果按类型渲染」的思路。依赖 B3。
- **验收**：可导出可读的 HTML/JSONL。

#### B17 模型解析带诊断 + 远程 catalog 刷新
- **pi 来源**：`core/model-resolver.ts`、`core/model-registry.ts`、`core/remote-catalog-provider.ts`、`core/provider-composer.ts`。
- **blh 现状**：`providers/catalog.ts`（内置）+ `registry.ts` 较简单，无解析诊断、无远程 catalog。
- **建议**：把模型/provider 解析错误纳入 B1 诊断体系；远程 catalog 刷新按需。依赖 B1。
- **验收**：模型解析错误以诊断形式聚合上报。

#### B18 复杂模块同目录设计说明
- **pi 来源**：源码同目录 `.md`（如 `core/agent-session.md`、`core/agent-session-runtime.md`）。
- **blh 现状**：`docs/plans` + `docs/superpowers/specs` 体系已很好，但复杂源码旁无即时说明。
- **建议**：对 `src/runtime/loop.ts`、`src/session/transcript.ts` 各写一份同目录设计说明，其余按需。
- **验收**：新同学看源码前先看同目录 .md。

## 五、明确不做（避免重复造轮子 / 不照搬 pi）

1. **不推倒 ports/DI + 事件溯源架构**：blh 的 `runtime/ports.ts`、`session/transcript.ts`（append/compact/rollbackTo/cancelMessage + projection）已经优于 pi 的会话模型，保持不动。
2. **不照搬 HookBus 的返回值收集式 hook**：blh 的 `HookBus.firstBlock` 阻断语义比 pi 更清晰，保留并只在载荷类型上细化（见 B6）。
3. **不引入 TUI**：pi 的 interactive TUI（`modes/interactive`）依赖其私有 `pi-tui`，blh 已选择 REPL + Web 前端，不重复建设 TUI。
4. **不照搬 provider 重试**：blh 的 `providers/retry.ts`（Retry-After + 指数退避 + abort 不重试）比 pi 更细，保持。
5. **不照搬破坏性命令检测**：blh 的 `security/rules.ts` 覆盖 rm -rf / force push / find -delete / mkfs / dd / PowerShell Remove-Item，比 pi 更全，保持。
6. **不引入 pi 的 `@earendil-works/*` workspace 依赖**（pi-agent-core、pi-ai、pi-tui、photon 等）：仅借鉴设计思路，不引外部包。
7. **不机械照搬主题系统**：主题系统与 blh 的 Web 前端样式体系重叠，暂不做；只保留「JSON Schema 校验用户配置」这一思路，按需应用。

## 六、建议执行顺序与依赖

```text
第一批（无依赖、快赢）：B2 迁移框架 → B1 diagnostics → B4 EventBus → B7 工具截断/路径
第二批（依赖第一批）：    B3 会话版本化（依赖 B2） → B5 skills 校验 → B6 hook 强类型 → B13 cause 解包
第三批（大改，评审后定）：B8 会话切换骨架（依赖 B3） → B9 富扩展 API（依赖 B4/B6）
第四批（按需）：           B10/B11/B12/B14/B15/B16/B17/B18
```

推荐从 **B2 + B1 + B4 + B7** 起步：它们相互独立、成本低、能立刻提升可观测性与健壮性，且不触碰核心循环与外部接口。

## 七、执行状态

- [x] B1 统一 diagnostics 系统
- [ ] B2 一次性迁移框架
- [ ] B3 会话条目版本化 + custom/label/session_info 预留
- [ ] B4 EventBus channel 化 + clear()
- [ ] B5 SkillLoader 规范校验 + ignore
- [ ] B6 hook 载荷按工具强类型化
- [ ] B7 工具输出统一截断 + 路径校验
- [ ] B8 会话切换「工厂闭包」骨架
- [ ] B9 富扩展 API
- [ ] B10 启动耗时埋点
- [ ] B11 会话/配置文件锁
- [ ] B12 项目信任持久化
- [ ] B13 错误 cause 链解包
- [ ] B14 changelog 提示 + 版本检查
- [ ] B15 内置工具探测/下载/降级
- [ ] B16 会话导出 HTML/JSONL + 分享
- [ ] B17 模型解析诊断 + 远程 catalog
- [ ] B18 复杂模块同目录设计说明