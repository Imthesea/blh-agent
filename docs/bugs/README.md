# Bug 案例库（复盘沉淀）

> 每修掉一个有代表性的 bug，按下面模板追加一篇案例。重点记录**根因（代码层）**和**教训**，而不只是「症状 + 修复」——这些案例最值钱的地方在于：它们暴露了代码里容易被再次踩中的细节。

## 案例模板

```markdown
## Bug：<一句话标题>

- **日期**：YYYY-MM-DD
- **影响模块**：src/runtime/hooks.ts 等
- **症状**：用户/系统观察到的现象
- **证据**：日志 / trace / session 里的关键片段（脱敏）
- **根因**：代码层，精确到 文件:行，讲清因果链
- **修复**：改了什么、为什么这么改
- **回归测试**：哪个测试文件/用例锁定了它
- **教训**：这类 bug 的通用信号，下次怎么提前发现
```

## 案例索引

- [2026-10-21 权限 hook 崩溃 + fail-open](./2026-10-21-hook-fail-open.md)
- [2026-10-21 todo 提醒无界注入 + 回合失控](./2026-10-21-todo-reminder-and-runaway-turn.md)
- [2026-10-21 成本恒 0：价格表缺新模型且静默返回 null](./2026-10-21-cost-zero-unknown-model.md)
- [2026-10-22 DeepSeek thinking 消失：reasoning_content 全链路未透传](./2026-10-22-deepseek-reasoning-dropped.md)
