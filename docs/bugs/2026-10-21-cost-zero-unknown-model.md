## Bug：成本恒 0——价格表缺新模型且 `costFor` 静默返回 null

- **日期**：2026-10-21
- **影响模块**：`src/tracing/pricing.ts`、`src/tracing/tracer.ts`
- **症状**：Observability 面板里每次 LLM 调用后 `cost_usd` 恒为 0，总花费/按天成本图永远是 0。
- **证据**：trace 的 `turn_end` 事件 `cost_usd` 字段为 0；`tracer.recordUsage` 在 `costFor` 返回 null 时既不累加也不告警。
- **根因**：`MODEL_PRICES` 里只有过时的 `deepseek-reasoner`/`deepseek-chat` 等条目，没有实际使用的 `deepseek-flash`；`costFor` 对未知模型返回 `null`，调用方 `tracer.recordUsage` 只在非 null 时累加，于是静默吞掉。价格表和「成本计算成功与否」之间没有任何反馈通道。
- **修复**：
  1. 按 DeepSeek 官方定价补齐 `deepseek-flash`（cache-miss + off-peak 基础价 $0.15/$0.6）与 `deepseek-v4-pro`（$0.66/$1.98），并把 `deepseek-chat`/`deepseek-reasoner` 等 legacy 别名兜底到 Flash 价。
  2. `costFor` 返回 null 时，`tracer` 对**首次**遇到的未知模型 `log.warn`（跨 Tracer 实例去重），不再静默。
- **回归测试**：`test/tracing/pricing.test.ts`（新价格与 legacy 别名断言）、`test/tracing/tracer.test.ts`（未知模型告警路径由 cost 累加逻辑覆盖）。
- **教训**：任何「查表 + 未命中即静默」的映射，都要给未命中一条显式告警；价格/常量这类容易过期的表，写死时必须带来源与日期注释，并优先考虑可覆盖（config）。同类 bug 信号：面板上某个指标长期为 0 或恒定值，先怀疑「数据源没接上」而不是「真的没有数据」。
