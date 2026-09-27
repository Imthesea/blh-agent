import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTraceModule } from "../../src/tracing/module.js";
import { localDate } from "../../src/tracing/tracer.js";

function setup(traceLines: string[], ledgerLines: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
  const traces = path.join(dir, ".blh", "traces");
  fs.mkdirSync(traces, { recursive: true });
  if (traceLines.length > 0) {
    fs.writeFileSync(path.join(traces, `${localDate()}.jsonl`), traceLines.join("\n") + "\n");
  }
  if (ledgerLines.length > 0) {
    fs.writeFileSync(path.join(dir, ".blh", "usage.jsonl"), ledgerLines.join("\n") + "\n");
  }
  return dir;
}

const TURN_EVENTS = [
  JSON.stringify({ ts: 1000, type: "turn_start", sid: "s1", turn: 1, user_message: "hi" }),
  JSON.stringify({ ts: 1100, type: "llm", sid: "s1", turn: 1, provider: "deepseek", model: "deepseek-chat", status: "ok", latency_ms: 50 }),
  JSON.stringify({ ts: 1200, type: "tool", sid: "s1", turn: 1, tool: "bash", args_summary: "ls", latency_ms: 10, status: "ok", output_summary: "x" }),
  JSON.stringify({ ts: 1300, type: "turn_end", sid: "s1", turn: 1, latency_ms: 300, iterations: 1, tools_used: 1, cost_usd: 0.001 }),
];

describe("files", () => {
  it("列出 trace 日期文件（倒序，过滤非法文件名）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const traces = path.join(dir, ".blh", "traces");
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(path.join(traces, "2026-09-27.jsonl"), "");
    fs.writeFileSync(path.join(traces, "2026-09-26.jsonl"), "");
    fs.writeFileSync(path.join(traces, "notes.txt"), "");
    const m = createTraceModule(dir) as { files(): string[] };
    expect(m.files()).toEqual(["2026-09-27", "2026-09-26"]);
  });

  it("目录不存在返回空数组", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const m = createTraceModule(dir) as { files(): string[] };
    expect(m.files()).toEqual([]);
  });
});

describe("events 游标语义", () => {
  it("cursor=0 返回全部事件与 nextCursor", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: unknown[]; nextCursor: number } };
    const r = m.events(0);
    expect(r.events.length).toBe(4);
    expect(r.nextCursor).toBe(4);
  });

  it("cursor 增量拉取", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: Array<{ type: string }>; nextCursor: number } };
    const r = m.events(2);
    expect(r.events.map((e) => e.type)).toEqual(["tool", "turn_end"]);
    expect(r.nextCursor).toBe(4);
  });

  it("cursor 越界归位（返回空 + 当前 total）", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: unknown[]; nextCursor: number } };
    const r = m.events(99);
    expect(r.events).toEqual([]);
    expect(r.nextCursor).toBe(4);
  });

  it("指定历史日期读取对应文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const traces = path.join(dir, ".blh", "traces");
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(path.join(traces, "2026-09-26.jsonl"), TURN_EVENTS[0]! + "\n");
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: unknown[]; nextCursor: number } };
    const r = m.events(0, "2026-09-26");
    expect(r.events.length).toBe(1);
    expect(r.nextCursor).toBe(1);
  });
});

describe("turns", () => {
  it("折叠当日事件并按时间倒序返回", () => {
    const second = TURN_EVENTS.map((l) =>
      l.replace('"turn":1', '"turn":2').replace('"user_message":"hi"', '"user_message":"second"'),
    );
    const dir = setup([...TURN_EVENTS, ...second]);
    const m = createTraceModule(dir) as { turns(o?: { limit?: number }): Array<{ userMessage: string; toolsUsed: number }> };
    const turns = m.turns();
    expect(turns.length).toBe(2);
    expect(turns[0]!.userMessage).toBe("second");
    expect(turns[1]!.toolsUsed).toBe(1);
  });

  it("limit 生效", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { turns(o?: { limit?: number }): unknown[] };
    expect(m.turns({ limit: 1 }).length).toBe(1);
  });
});

describe("overview", () => {
  it("聚合账本与当日 turn 统计", () => {
    const dir = setup(TURN_EVENTS, [
      JSON.stringify({ ts: 1250, sid: "s1", provider: "deepseek", model: "deepseek-chat", in: 100, out: 50 }),
    ]);
    const m = createTraceModule(dir) as {
      overview(): {
        usage: { total: { in: number } };
        today: { turns: number; tools: number; avgLatencyMs: number };
        recentTurns: Array<{ userMessage: string }>;
      };
    };
    const o = m.overview();
    expect(o.usage.total.in).toBe(100);
    expect(o.today.turns).toBe(1);
    expect(o.today.tools).toBe(1);
    expect(o.today.avgLatencyMs).toBe(300);
    expect(o.recentTurns[0]!.userMessage).toBe("hi");
  });

  it("空目录返回零值", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const m = createTraceModule(dir) as {
      overview(): { today: { turns: number; tools: number; avgLatencyMs: number }; recentTurns: unknown[] };
    };
    const o = m.overview();
    expect(o.today).toEqual({ turns: 0, tools: 0, avgLatencyMs: 0 });
    expect(o.recentTurns).toEqual([]);
  });
});
