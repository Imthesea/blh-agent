import { describe, expect, it } from "vitest";
import { collectApprovals, fmtLatency, recentCostBars, slowestTurns } from "./observe-utils";
import type { FoldedTurn } from "@blh/web-client";

function turn(partial: Partial<FoldedTurn> & { sid: string; turn: number }): FoldedTurn {
  return {
    userMessage: "",
    startedAt: 0,
    finished: true,
    cancelled: false,
    latencyMs: null,
    iterations: 0,
    toolsUsed: 0,
    costUsd: 0,
    events: [],
    ...partial,
  };
}

describe("fmtLatency", () => {
  it("null 显示占位", () => {
    expect(fmtLatency(null)).toBe("—");
  });

  it("毫秒转秒保留一位小数", () => {
    expect(fmtLatency(1500)).toBe("1.5s");
    expect(fmtLatency(0)).toBe("0.0s");
  });
});

describe("collectApprovals", () => {
  it("按顺序展开各 turn 的 approval 事件", () => {
    const turns: FoldedTurn[] = [
      turn({
        sid: "a", turn: 1,
        events: [
          { ts: 1, type: "llm", sid: "a", turn: 1 },
          { ts: 2, type: "approval", sid: "a", turn: 1, decision: "allow" },
        ],
      }),
      turn({
        sid: "a", turn: 2,
        events: [{ ts: 3, type: "approval", sid: "a", turn: 2, decision: "deny" }],
      }),
    ];
    expect(collectApprovals(turns).map((e) => e.decision)).toEqual(["allow", "deny"]);
  });

  it("无 approval 返回空数组", () => {
    expect(collectApprovals([])).toEqual([]);
    expect(
      collectApprovals([turn({ sid: "a", turn: 1, events: [{ ts: 1, type: "llm", sid: "a", turn: 1 }] })]),
    ).toEqual([]);
  });
});

describe("slowestTurns", () => {
  it("过滤 null、按延迟降序、截断到 limit", () => {
    const turns = [
      turn({ sid: "a", turn: 1, latencyMs: 300 }),
      turn({ sid: "a", turn: 2, latencyMs: null }),
      turn({ sid: "a", turn: 3, latencyMs: 500 }),
      turn({ sid: "a", turn: 4, latencyMs: 100 }),
    ];
    const slowest = slowestTurns(turns, 2);
    expect(slowest.map((t) => t.latencyMs)).toEqual([500, 300]);
  });
});

describe("recentCostBars", () => {
  it("空数据返回空数组", () => {
    expect(recentCostBars({})).toEqual([]);
  });

  it("按日期升序取最近 days 天", () => {
    const byDay: Record<string, { costUsd: number }> = {};
    for (let i = 1; i <= 20; i++) {
      byDay[`2026-09-${String(i).padStart(2, "0")}`] = { costUsd: i };
    }
    const bars = recentCostBars(byDay, 14);
    expect(bars).toHaveLength(14);
    expect(bars[0]!.day).toBe("2026-09-07");
    expect(bars.at(-1)!.day).toBe("2026-09-20");
  });

  it("柱高按最大值归一，最小值 2%", () => {
    const bars = recentCostBars({
      "2026-09-01": { costUsd: 1 },
      "2026-09-02": { costUsd: 2 },
      "2026-09-03": { costUsd: 0 },
    });
    expect(bars.map((b) => b.heightPercent)).toEqual([50, 100, 2]);
  });

  it("全零成本时柱高恒为 2%", () => {
    const bars = recentCostBars({ "2026-09-01": { costUsd: 0 } });
    expect(bars[0]!.heightPercent).toBe(2);
  });
});
