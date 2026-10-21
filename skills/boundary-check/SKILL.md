---
name: boundary-check
description: 在给 blh 加任何新功能前，审查该功能读/算/展示的数据会不会只增不减、越用越大，并给出增量机制或上限要求。当用户要新增功能、新增后台或定时任务、新增日志·trace·轮询页面、新增持久化数据时使用。不要用于：修 bug、格式化代码、纯解释代码。
---

# 边界审查（防无限膨胀）

## 触发时机

当用户要**新增**以下内容时使用本 skill：

- 新功能、新页面、新接口
- 后台 bash、cron 定时任务
- 日志 / trace / 用量 / 会话历史 / 消息列表 / 任务列表等**追加型存储**
- 任何"跑得越久数据越多"的东西

不要用于修 bug、格式化、解释代码——那是 `bug-fix` 的活。

## 核心一问

**这个功能读 / 算 / 展示的数据，会不会只增不减、越用越大？**

只要答案可能是"会"，设计里就必须给出增量机制或明确上限，**禁止写"全量读 / 全量算 / 全量画"**。

## 审查流程

1. 跑反模式扫描，拿可疑点清单：

   ```bash
   node scripts/scan-boundary.mjs            # 默认扫 src/ apps/
   node scripts/scan-boundary.mjs src/tracing apps/web-server/src
   node scripts/scan-boundary.mjs --json
   ```

2. 对照下面 5 步清单逐项审查，每项给结论（通过 / 有问题 + 证据：文件 + 行号）。
3. 把结论填进 `assets/review-template.md`。
4. 若新增了追加型存储，先登记进 `references/registry.md`，再按清单设计。

## 5 步清单

### 1. 识别：数据会不会无限长大？

- 日志、trace、用量记录、会话历史、消息列表、任务列表……凡是**追加型**数据，默认无限长大。
- 会长大 → 2/3/4/5 必须全部落实；不会长大（如配置文件）→ 跳过。

### 2. 读取：有没有"书签"？

- 禁止：每次从头读全量文件 / 全表。
- 应该：记录 offset / cursor / lastId，只读增量。
- 必须处理边界：半行（写了一半的行下次拼上）、坏行（占位不丢行号）、文件被截断或删除重建（size 变小则重置）。
- 参考 `src/tracing/store.ts` 的 `JsonlTail`。

### 3. 计算：有没有缓存 + 脏标记？

- 禁止：每次请求把全部数据重新 parse / fold / 聚合。
- 应该：结果缓存，有新数据才重算；统计类用增量累加器（`src/tracing/pricing.ts` 的 `createUsageAccumulator`），防止追加后重复累加翻倍。
- 缓存自己的边界：按 key 缓存的要有淘汰上限（本项目 LRU 保留 8 天），否则缓存本身又成了新的无界点。

### 4. 展示：有没有分页/截尾 + 防重画？

- 禁止：把全部数据塞给前端、每次轮询整页重画。
- 应该：首载只取尾部 N 条 + 总数（"显示 X / 共 Y 行"），之后增量轮询；数据没变不 `setState`（参考 `TracePage.tsx` 的 JSON 比较）。

### 5. 测试：有没有"数据变多"的用例？

- 至少一条断言"追加数据后成本不随总量翻倍"。例如：追加 1 行只多读 1 行字节（`stats().bytesRead`）、usage 追加后不翻倍。
- 参考 `test/tracing/store.test.ts` 的 14 条用例（半行、坏行、截断、删除重建、LRU 淘汰、usage 防翻倍）。

## 参考

- `references/case-study.md` —— Ops/Trace 越用越卡的教训案例
- `references/registry.md` —— 已确认只增不减数据点 + 参考实现
- `assets/review-template.md` —— 边界审查记录模板
- `evals/evals.json` —— 触发与行为测试
