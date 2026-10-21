import { describe, expect, it } from "vitest";
import {
  costFor,
  createUsageAccumulator,
  mergeUsageSummaries,
  type UsageLine,
} from "../../src/tracing/pricing.js";

describe("costFor", () => {
  it("deepseek-flash 使用 cache-miss + off-peak 基础价", () => {
    expect(costFor("deepseek-flash", 1_000_000, 1_000_000)).toBeCloseTo(0.15 + 0.6, 6);
    expect(costFor("deepseek-flash", 1_000_000, 0)).toBeCloseTo(0.15, 6);
  });

  it("大小写不敏感", () => {
    expect(costFor("DeepSeek-Flash", 1_000_000, 0)).toBeCloseTo(0.15, 6);
  });

  it("legacy 别名 deepseek-chat / deepseek-reasoner 按 Flash 计费", () => {
    expect(costFor("deepseek-chat", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(costFor("deepseek-reasoner", 1_000_000, 0)).toBeCloseTo(0.15, 6);
  });

  it("deepseek-v4-pro 单独计价", () => {
    expect(costFor("deepseek-v4-pro", 1_000_000, 1_000_000)).toBeCloseTo(0.66 + 1.98, 6);
  });

  it("未知模型返回 null", () => {
    expect(costFor("mystery-model", 100, 100)).toBeNull();
  });
});

describe("createUsageAccumulator", () => {
  const rec = (o: Partial<UsageLine> & { in: number; out: number }): UsageLine => ({
    ts: Date.parse("2026-09-27T10:00:00"),
    provider: "deepseek",
    model: "deepseek-flash",
    ...o,
  });

  it("空累加器返回零值", () => {
    const s = createUsageAccumulator().summary();
    expect(s.total).toEqual({ in: 0, out: 0, costUsd: 0 });
    expect(s.byDay).toEqual({});
    expect(s.byProvider).toEqual({});
    expect(s.byModel).toEqual({});
  });

  it("聚合 total/byDay/byProvider/byModel 并计算成本", () => {
    const acc = createUsageAccumulator();
    acc.add(rec({ ts: Date.parse("2026-09-27T10:00:00"), in: 1000, out: 2000 }));
    acc.add(rec({ ts: Date.parse("2026-09-27T11:00:00"), in: 500, out: 500 }));
    acc.add(rec({ ts: Date.parse("2026-09-26T09:00:00"), provider: "unknown", model: "mystery", in: 100, out: 100 }));
    const s = acc.summary();
    expect(s.total.in).toBe(1600);
    expect(s.total.out).toBe(2600);
    // deepseek-flash: 1500*0.15/1M + 2500*0.6/1M = 0.000225 + 0.0015
    expect(s.total.costUsd).toBeCloseTo(0.000225 + 0.0015, 9);
    expect(Object.keys(s.byDay).sort()).toEqual(["2026-09-26", "2026-09-27"]);
    expect(s.byModel["deepseek-flash"]!.in).toBe(1500);
    expect(s.byModel["mystery"]!.costUsd).toBe(0);
    expect(s.byProvider["unknown"]!.in).toBe(100);
  });
});

describe("mergeUsageSummaries", () => {
  it("合并多天聚合，byDay 保持分天", () => {
    const a = createUsageAccumulator();
    a.add({ ts: Date.parse("2026-09-26T10:00:00"), provider: "deepseek", model: "deepseek-flash", in: 100, out: 10 });
    const b = createUsageAccumulator();
    b.add({ ts: Date.parse("2026-09-27T10:00:00"), provider: "deepseek", model: "deepseek-flash", in: 200, out: 20 });
    const merged = mergeUsageSummaries([a.summary(), b.summary()]);
    expect(merged.total.in).toBe(300);
    expect(merged.total.out).toBe(30);
    expect(Object.keys(merged.byDay).sort()).toEqual(["2026-09-26", "2026-09-27"]);
    expect(merged.byModel["deepseek-flash"]!.in).toBe(300);
  });
});
