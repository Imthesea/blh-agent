import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { costFor, usageSummary } from "../../src/tracing/pricing.js";

describe("costFor", () => {
  it("命中已知模型（大小写不敏感）", () => {
    expect(costFor("deepseek-chat", 1_000_000, 1_000_000)).toBeCloseTo(0.27 + 1.1, 6);
    expect(costFor("DeepSeek-Chat", 1_000_000, 0)).toBeCloseTo(0.27, 6);
  });

  it("长模式名优先（deepseek-reasoner 不被 deepseek-chat 抢先命中）", () => {
    expect(costFor("deepseek-reasoner", 1_000_000, 1_000_000)).toBeCloseTo(0.55 + 2.19, 6);
  });

  it("未知模型返回 null", () => {
    expect(costFor("mystery-model", 100, 100)).toBeNull();
  });
});

describe("usageSummary", () => {
  function writeLedger(lines: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-pricing-"));
    const blh = path.join(dir, ".blh");
    fs.mkdirSync(blh, { recursive: true });
    fs.writeFileSync(
      path.join(blh, "usage.jsonl"),
      lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    );
    return dir;
  }

  it("账本不存在时返回空聚合", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-pricing-"));
    const s = usageSummary(dir);
    expect(s.total).toEqual({ in: 0, out: 0, costUsd: 0 });
    expect(s.byDay).toEqual({});
    expect(s.byProvider).toEqual({});
    expect(s.byModel).toEqual({});
  });

  it("聚合 total/byDay/byProvider/byModel 并计算成本，坏行跳过", () => {
    const dir = writeLedger([
      { ts: Date.parse("2026-09-27T10:00:00"), sid: "a", provider: "deepseek", model: "deepseek-chat", in: 1000, out: 2000 },
      { ts: Date.parse("2026-09-27T11:00:00"), sid: "a", provider: "deepseek", model: "deepseek-chat", in: 500, out: 500 },
      { ts: Date.parse("2026-09-26T09:00:00"), sid: "b", provider: "unknown", model: "mystery", in: 100, out: 100 },
      "{bad json",
    ]);
    const s = usageSummary(dir);
    expect(s.total.in).toBe(1600);
    expect(s.total.out).toBe(2600);
    // deepseek-chat: 1500*0.27/1M + 2500*1.10/1M = 0.000405 + 0.00275
    expect(s.total.costUsd).toBeCloseTo(0.000405 + 0.00275, 9);
    const day = Object.keys(s.byDay).sort();
    expect(day.length).toBe(2);
    expect(s.byModel["deepseek-chat"]!.in).toBe(1500);
    expect(s.byModel["mystery"]!.costUsd).toBe(0);
    expect(s.byProvider["unknown"]!.in).toBe(100);
  });
});
