import type { FoldedTurn, TraceEvent } from "@blh/web-client";

/** 延迟格式化为「1.5s」；null 显示「—」。 */
export function fmtLatency(ms: number | null): string {
  return ms !== null ? `${(ms / 1000).toFixed(1)}s` : "—";
}

/** 展开所有 turn 里的 approval 事件（按 turn 顺序、事件顺序）。 */
export function collectApprovals(turns: FoldedTurn[]): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const turn of turns) {
    for (const event of turn.events) {
      if (event.type === "approval") out.push(event);
    }
  }
  return out;
}

/** 按延迟降序取最慢的 N 个已完成 turn（过滤 latencyMs 为 null 的）。 */
export function slowestTurns(turns: FoldedTurn[], limit = 10): FoldedTurn[] {
  return [...turns]
    .filter((turn) => turn.latencyMs !== null)
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
    .slice(0, limit);
}

export interface CostBar {
  day: string;
  costUsd: number;
  /** 柱高百分比（相对窗口内最大值；最大为 0 时恒 2，保证可见）。 */
  heightPercent: number;
}

/** 取最近 days 天（升序）的成本柱数据；柱高按窗口内最大值归一，最小 2%。 */
export function recentCostBars(
  byDay: Record<string, { costUsd: number }>,
  days = 14,
): CostBar[] {
  const entries = Object.entries(byDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-days);
  const max = entries.reduce((m, [, bucket]) => Math.max(m, bucket.costUsd), 0);
  return entries.map(([day, bucket]) => ({
    day,
    costUsd: bucket.costUsd,
    heightPercent: max > 0 ? Math.max(2, Math.round((bucket.costUsd / max) * 100)) : 2,
  }));
}
