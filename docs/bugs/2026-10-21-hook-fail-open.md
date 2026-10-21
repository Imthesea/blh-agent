# 2026-10-21 权限 hook 崩溃 + fail-open

## Bug：always_allow 存的完整命令被当 glob 编译，崩溃后安全 hook 反而放行

- **日期**：2026-10-21
- **影响模块**：`src/tools/glob.ts`、`src/security/rules.ts`、`src/security/approval.ts`、`src/runtime/hooks.ts`
- **症状**：日志里同一 `pre_tool_use` hook 错误刷屏 45 次，且命令照常执行（权限检查失效）。
- **证据**（脱敏）：
  - log：`runtime.hooks hook error event=pre_tool_use error="Invalid regular expression: ... Range out of order in character class"`
  - `.blh/user-rules.json` 里一条 `always_allow` 规则的 `target` 是**整条 bash 命令原文**，含 `[a-z0-9\-/]`、`[^<\s]` 等正则片段。

- **根因**（三个缺陷叠加）：
  1. `src/security/approval.ts` `always_allow` 分支把 `target = 完整命令` 存成 glob 规则，命令里的 `[` `-` `*` 被当成 glob 元字符。
  2. `src/tools/glob.ts` `fnmatch` 的 glob→正则编译对 `[...]` 字符类内非法 range 不设防，`new RegExp` 抛「Range out of order in character class」。
  3. `src/runtime/hooks.ts` `firstBlock` 把 hook 抛异常吞掉当「未拦截」，安全 hook 崩溃 = 放行（fail-open）。

- **修复**：
  1. `fnmatch` 的 `new RegExp` 包 try/catch，编译失败降级为字面量精确匹配（`name === pattern`），永不抛。
  2. `PermissionRule` 加 `exact?: boolean`；`always_allow` 存 `exact: true`；`matchRule` 对 exact 规则用 `===` 而非 glob。
  3. `firstBlock` 对抛错的 hook **失败关闭**——返回 `denied: <event> hook failed (<msg>)` 阻断结果，而不是放行；`trigger` 保持容错。

- **回归测试**：
  - `test/tools/glob.test.ts`：非法字符类 range 不抛、降级字面量匹配。
  - `test/security/rules.test.ts`：exact 规则精确匹配、不做 glob。
  - `test/security/approval.test.ts`：`always_allow` 持久化带 `exact: true`。
  - `test/runtime/hooks.test.ts`：`firstBlock` 对抛错 hook 返回阻断而非放行。
  - 端到端验证：`user-rules.json` 9 条规则 0 崩溃，IOLANI 规则精确命中自己、不误伤 `ls -la`。

- **教训**：
  1. **「用户精确放行的命令」绝不能当 glob 编译**——命令里的 `[` `-` `*` 是数据不是模式。精确匹配和 glob 匹配必须是两种规则。
  2. **安全类 hook 必须 fail-closed**：权限检查抛异常 ≠ 「没拦截」，而是「不确定」——不确定就该拦。
  3. 正则/glob 编译是「用户输入 → 正则」的经典崩点，任何 `new RegExp(用户内容)` 都要 try/catch 或转义。
