/**
 * 成本定价：USD / 1M tokens。
 *
 * DeepSeek 官方定价（https://api-docs.deepseek.com/quick_start/pricing）区分
 * cache hit / cache miss 与 off-peak / peak。这里取 cache-miss + off-peak 作为基础价：
 * 不含 cache 命中优惠、不区分峰谷（peak = off-peak × 2），因此成本表可能略高于实际账单。
 */

/** USD per 1M tokens: [input, output]。长模式名在前，includes 匹配时优先命中。 */
const MODEL_PRICES: Array<[pattern: string, input: number, output: number]> = [
  // DeepSeek（cache-miss + off-peak 基础价）
  ["deepseek-v4-pro", 0.66, 1.98],
  ["deepseek-flash", 0.15, 0.6],
  // 旧名 deepseek-chat / deepseek-reasoner / deepseek-v4-flash* 官方已按 Flash 计费，
  // 用 "deepseek" 兜底匹配所有未单独列出的 DeepSeek 模型。
  ["deepseek", 0.15, 0.6],
  ["qwen-turbo", 0.05, 0.2],
  ["qwen-plus", 0.4, 1.2],
  ["qwen-max", 1.6, 6.4],
  ["moonshot", 0.6, 2.5],
  ["kimi", 0.6, 2.5],
  ["claude-opus", 15, 75],
  ["claude-sonnet", 3, 15],
  ["claude-haiku", 0.8, 4],
];

export function costFor(model: string, inTokens: number, outTokens: number): number | null {
  const m = model.toLowerCase();
  for (const [pattern, i, o] of MODEL_PRICES) {
    if (m.includes(pattern)) {
      return (inTokens * i + outTokens * o) / 1_000_000;
    }
  }
  return null;
}

export interface UsageBucket {
  in: number;
  out: number;
  costUsd: number;
}

export interface UsageSummary {
  total: UsageBucket;
  byDay: Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
}

/** 单一 usage 输入（由 llm trace 事件投影而来）。 */
export interface UsageLine {
  ts: number;
  provider: string;
  model: string;
  in: number;
  out: number;
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyBucket(): UsageBucket {
  return { in: 0, out: 0, costUsd: 0 };
}

function add(bucket: UsageBucket, rec: UsageLine): void {
  bucket.in += rec.in;
  bucket.out += rec.out;
  bucket.costUsd += costFor(rec.model, rec.in, rec.out) ?? 0;
}

export interface UsageAccumulator {
  add(rec: UsageLine): void;
  /** 返回内部累积对象（只读使用，勿修改）。 */
  summary(): UsageSummary;
}

/** 增量累加器：每条记录只累加一次，供 TraceStore 随文件增长持续投喂。 */
export function createUsageAccumulator(): UsageAccumulator {
  const s: UsageSummary = { total: emptyBucket(), byDay: {}, byProvider: {}, byModel: {} };
  return {
    add(rec) {
      add(s.total, rec);
      add((s.byDay[dayOf(rec.ts)] ??= emptyBucket()), rec);
      add((s.byProvider[rec.provider] ??= emptyBucket()), rec);
      add((s.byModel[rec.model] ??= emptyBucket()), rec);
    },
    summary() {
      return s;
    },
  };
}

export function emptyUsageSummary(): UsageSummary {
  return { total: emptyBucket(), byDay: {}, byProvider: {}, byModel: {} };
}

function addBucket(target: UsageBucket, src: UsageBucket): void {
  target.in += src.in;
  target.out += src.out;
  target.costUsd += src.costUsd;
}

/** 合并多个按天聚合（各 day summary 的 byDay 只有一个键，合并成全局 byDay）。 */
export function mergeUsageSummaries(days: UsageSummary[]): UsageSummary {
  const out = emptyUsageSummary();
  for (const d of days) {
    addBucket(out.total, d.total);
    for (const [k, v] of Object.entries(d.byDay)) addBucket((out.byDay[k] ??= emptyBucket()), v);
    for (const [k, v] of Object.entries(d.byProvider)) addBucket((out.byProvider[k] ??= emptyBucket()), v);
    for (const [k, v] of Object.entries(d.byModel)) addBucket((out.byModel[k] ??= emptyBucket()), v);
  }
  return out;
}
