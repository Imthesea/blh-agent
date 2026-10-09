---
name: code-review
description: 按 blh 的架构、安全与权限规范审查代码变更，输出带优先级(P0/P1/P2)的分级问题清单与具体改法。当用户要求 review、审查代码、检查改动或评估 PR 时使用。
---

# code-review

对 blh 仓库的代码变更做结构化审查。目标是发现会破坏架构、引入安全风险、绕过权限体系或降低可维护性的问题，而不是改代码。

## 触发时机

当用户说“review / 审查 / 看看这段代码 / 检查 PR / 这个改动有没有问题”时使用本 skill。只输出审查意见，不直接修改文件，除非用户明确要求“顺便改掉”。

## 审查清单

按下面顺序逐项检查，每项先给结论（通过 / 有问题），再给证据。

### 1. 类型安全
- 新代码是否有完整类型标注，避免使用 `any`、`as` 强制断言掩盖问题。
- 是否复用 `src/contracts/` 下的共享类型，而不是各模块重复定义。
- 对外暴露的类型是否通过 `interface`/`type` 明确形状，是否处理 `null` / `undefined`。

### 2. 权限与安全（重点）
- 新工具是否遵循 `PreToolUse` 钩子的放行/拒绝/询问协议，未绕过 `src/security/approval.ts`。
- 破坏性命令是否仍会被 `isDestructiveBashCommand` 硬拦截（`rm -rf`、`git push --force`、`find -delete`、`mkfs`/`dd` 写设备），且 `--dangerously-skip-permissions` 也不能绕过。
- 是否新增了应默认 `deny` 的规则（如 `git push --force*`、`rm -rf /*`），以及用户规则是否通过 `insertUserRule` 插在硬性 deny 之后。
- dream 轮（后台/定时任务）是否只允许写入 `.memory/` 白名单，未越权写其它路径。
- Web 后端（`@blh/web-server`）是否仍满足：只监听回环地址、校验 Host 头防 DNS rebinding、自定义头防 CSRF。
- 敏感信息（API key、token）是否被写入日志、trace 或前端可见输出。

### 3. 错误处理与重试
- 对厂商 API 是否覆盖 `429` / `5xx` 的自动重试，并遵守 `Retry-After` 与退避抖动。
- 重试是否设置上限与可观测日志，避免无限重试或静默失败。
- 新增的异步/后台任务是否有明确的失败路径与状态回收。

### 4. 架构边界（对应 architecture.config.json）
- 新目录是否落入 `featureDirectories` / `sharedDirectories` 之一；跨 feature 的依赖是否命中 `allowedFeatureEdges`。
- 是否有人偷偷绕过 `compositionRoot: "cli"`，在 feature 内部直接 new 出跨模块对象，破坏依赖方向。
- 新增跨模块依赖是否同步更新 `architecture.config.json`，并能通过 `pnpm lint`（含 `node scripts/check-architecture.mjs`）。

### 5. 工具注册规范
- 新工具是否通过 `ToolRegistry.register` 注册，`parameters` 是否为合法 JSON Schema（`type`/`properties`/`required`）。
- 工具的 `description` 是否说清“何时用、输入什么、返回什么”，便于模型正确选择。
- handler 是否校验入参类型，而不是信任模型传入的任意值。

### 6. 上下文与可观测性
- 新逻辑是否接入 `logger`（`createLogger`）与 `tracer`，关键事件可追踪。
- 长任务是否考虑上下文压缩 / 摘要，避免无界增长。
- 新增文件是否遵守 monorepo + pnpm workspace 约定，未在根与子包间产生循环依赖。

### 7. 测试与评测
- 关键分支是否有 `vitest` 用例；纯逻辑（如权限匹配、命令解析）是否可脱离网络单测。
- 改动是否影响 SWE-bench 评测路径（`scripts/swebench-run.ts`），是否需要回归。

## 输出格式

严格按以下结构输出，便于直接落 bug：

```
## 审查结论
一句话总结：整体可合入 / 建议修改后合入 / 不建议合入。

## 问题清单
- [P0] 文件:行号 — 问题描述
  建议：具体改法
- [P1] 文件:行号 — 问题描述
  建议：具体改法
- [P2] 文件:行号 — 问题描述
  建议：具体改法
```

优先级定义：
- **P0**：安全漏洞、权限绕过、架构破坏、会导致线上故障，必须改。
- **P1**：类型/错误处理缺陷、可维护性明显下降，应改。
- **P2**：命名、注释、风格等建议项，可后续处理。

## 禁止事项
- 不臆造问题：每条意见必须能指向具体文件与行号。
- 不直接修改代码，只输出审查意见。
- 不泄露 `.env` 中的真实密钥，引用时用 `<REDACTED>` 代替。