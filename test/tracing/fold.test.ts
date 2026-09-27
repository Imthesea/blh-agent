import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldEvents, readTraceFile } from "../../src/tracing/fold.js";
import type { TraceEvent } from "../../src/tracing/types.js";

function ev(partial: Partial<TraceEvent> & { type: string }): TraceEvent {
  return { ts: 1000, sid: "s1", turn: 1, ...partial };
}

describe("foldEvents", () => {
  it("按 sid#turn 分组并保序", () => {
    const turns = foldEvents([
      ev({ type: "turn_start", user_message: "one" }),
      ev({ type: "llm" }),
      ev({ type: "turn_end", latency_ms: 50, iterations: 1, tools_used: 0, cost_usd: 0 }),
      ev({ type: "turn_start", turn: 2, user_message: "two" }),
      ev({ type: "turn_end", turn: 2, latency_ms: 30, iterations: 0, tools_used: 0, cost_usd: 0 }),
    ]);
    expect(turns.length).toBe(2);
    expect(turns[0]!.userMessage).toBe("one");
    expect(turns[1]!.userMessage).toBe("two");
    expect(turns[0]!.events.map((e) => e.type)).toEqual(["turn_start", "llm", "turn_end"]);
  });

  it("turn_end 闭合 turn 并取聚合字段", () => {
    const turns = foldEvents([
      ev({ type: "turn_start", user_message: "hi" }),
      ev({ type: "turn_end", latency_ms: 120, iterations: 2, tools_used: 1, cost_usd: 0.001 }),
    ]);
    expect(turns[0]!.finished).toBe(true);
    expect(turns[0]!.cancelled).toBe(false);
    expect(turns[0]!.latencyMs).toBe(120);
    expect(turns[0]!.iterations).toBe(2);
    expect(turns[0]!.toolsUsed).toBe(1);
    expect(turns[0]!.costUsd).toBe(0.001);
  });

  it("turn_cancelled 标记取消；未闭合 turn finished=false", () => {
    const cancelled = foldEvents([
      ev({ type: "turn_start", user_message: "x" }),
      ev({ type: "turn_cancelled", latency_ms: 10, iterations: 1, tools_used: 0, cost_usd: 0, reason: "aborted" }),
    ]);
    expect(cancelled[0]!.cancelled).toBe(true);
    expect(cancelled[0]!.finished).toBe(true);

    const open = foldEvents([ev({ type: "turn_start", user_message: "y" })]);
    expect(open[0]!.finished).toBe(false);
  });
});

describe("readTraceFile", () => {
  it("读取 JSONL 并跳过坏行", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-fold-"));
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, JSON.stringify(ev({ type: "turn_start" })) + "\n{bad\n" + JSON.stringify(ev({ type: "turn_end" })) + "\n");
    const events = readTraceFile(file);
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("turn_start");
    expect(events[1]!.type).toBe("turn_end");
  });
});
