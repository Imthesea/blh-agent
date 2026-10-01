import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageRecord } from "./types.js";

/** USD per 1M tokens: [input, output]。长模式名在前，includes 匹配时优先命中。 */
const MODEL_PRICES: Array<[pattern: string, input: number, output: number]> = [
  ["deepseek-reasoner", 0.55, 2.19],
  ["deepseek-chat", 0.27, 1.1],
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

function dayOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyBucket(): UsageBucket {
  return { in: 0, out: 0, costUsd: 0 };
}

function add(bucket: UsageBucket, rec: UsageRecord): void {
  bucket.in += rec.in;
  bucket.out += rec.out;
  bucket.costUsd += costFor(rec.model, rec.in, rec.out) ?? 0;
}

export interface UsageAccumulator {
  add(rec: UsageRecord): void;
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

export function usageSummary(workdir: string): UsageSummary {
  const acc = createUsageAccumulator();
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(workdir, ".blh", "usage.jsonl"), "utf-8").split("\n");
  } catch {
    return acc.summary();
  }
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      acc.add(JSON.parse(line) as UsageRecord);
    } catch {
      // 坏行跳过
    }
  }
  return acc.summary();
}
