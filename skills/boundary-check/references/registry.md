# 只增不减数据点登记表 + 参考实现

## 已确认的追加型数据点

以下数据点已确认是追加型、只增不减。**任何新功能只要读写它们，必须按 SKILL.md 的 5 步清单执行。**

| 数据点 | 现状 |
|---|---|
| `<workdir>/.blh/traces/{date}.jsonl` | 已修：`JsonlTail` 增量读 |
| `<workdir>/.blh/usage.jsonl` | 已修：`usageTail` 增量读 |

> 以后新增的追加型存储（日志、历史、记录类），落地前先补进这张表，并按清单设计。

## 已落实的参考实现

| 层 | 文件 | 做了什么 |
|---|---|---|
| 读取 | `src/tracing/store.ts` | `JsonlTail` offset 增量读、半行暂存、截断/重建重置；`TraceStore` fold 缓存 + LRU 8 天 |
| 计算 | `src/tracing/pricing.ts` | `createUsageAccumulator` 增量累加器 |
| 接口 | `apps/web-server/src/trace.ts` | `?tail=N` 参数：首载只取尾部 N 行，不回放全量历史 |
| 前端 | `apps/web/src/components/observe/OpsPage.tsx` | 首载 tail=200 + 2s cursor 增量轮询 + "显示 X / 共 Y 行" |
| 前端 | `apps/web/src/components/observe/TracePage.tsx` | 数据没变不 `setState` |
| 测试 | `test/tracing/store.test.ts` | 14 条边界用例 |
