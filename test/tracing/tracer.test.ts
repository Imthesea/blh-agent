import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Tracer, localDate, summarize } from "../../src/tracing/tracer.js";

function makeTracer(): { tracer: Tracer; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-tracer-"));
  return { tracer: new Tracer(dir), dir };
}

function readDay(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, ".blh", "traces", `${localDate()}.jsonl`);
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("summarize", () => {
  it("短文本原样返回", () => {
    expect(summarize("hello")).toBe("hello");
  });

  it("超长截断并加省略号", () => {
    const out = summarize("x".repeat(600));
    expect(out.length).toBe(501);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("Tracer", () => {
  it("事件带统一信封，turn 边界聚合正确", () => {
    const { tracer, dir } = makeTracer();
    tracer.setSid("sess-1");
    tracer.beginTurn("帮我修个 bug");
    tracer.event("llm", { provider: "deepseek", model: "deepseek-flash", stream: true, status: "ok", latency_ms: 100 });
    tracer.event("llm", { provider: "deepseek", model: "deepseek-flash", stream: true, status: "ok", latency_ms: 80, usage: { promptTokens: 10, completionTokens: 5 } });
    tracer.event("tool", { tool: "bash", args_summary: "ls", latency_ms: 20, status: "ok", output_summary: "…" });
    tracer.endTurn();

    const events = readDay(dir);
    expect(events.map((e) => e["type"])).toEqual(["turn_start", "llm", "llm", "tool", "turn_end"]);
    for (const e of events) {
      expect(e["sid"]).toBe("sess-1");
      expect(e["turn"]).toBe(1);
      expect(typeof e["ts"]).toBe("number");
    }
    expect(events[0]!["user_message"]).toBe("帮我修个 bug");
    const end = events[4]!;
    expect(end["iterations"]).toBe(2);
    expect(end["tools_used"]).toBe(1);
    expect(typeof end["latency_ms"]).toBe("number");
    expect(end["cost_usd"]).toBeCloseTo((10 * 0.15 + 5 * 0.6) / 1_000_000, 12);
  });

  it("带 usage 的 llm 事件原样写入 trace，不再写 usage.jsonl", () => {
    const { tracer, dir } = makeTracer();
    tracer.beginTurn("hi");
    tracer.event("llm", { provider: "deepseek", model: "deepseek-flash", status: "ok", latency_ms: 10 });
    tracer.event("llm", { provider: "deepseek", model: "deepseek-flash", status: "ok", latency_ms: 10, usage: { promptTokens: 3, completionTokens: 4 } });
    tracer.event("tool", { tool: "read", args_summary: "a", latency_ms: 1, status: "ok", output_summary: "b" });
    tracer.endTurn();

    const events = readDay(dir);
    const llmWithUsage = events.filter((e) => e["type"] === "llm" && e["usage"] !== undefined);
    expect(llmWithUsage.length).toBe(1);
    expect(llmWithUsage[0]!["usage"]).toEqual({ promptTokens: 3, completionTokens: 4 });
    expect(fs.existsSync(path.join(dir, ".blh", "usage.jsonl"))).toBe(false);
  });

  it("cancelTurn 记录取消原因", () => {
    const { tracer, dir } = makeTracer();
    tracer.beginTurn("long task");
    tracer.event("llm", { provider: "deepseek", model: "m", status: "ok", latency_ms: 5 });
    tracer.cancelTurn("aborted");
    const events = readDay(dir);
    expect(events[2]!["type"]).toBe("turn_cancelled");
    expect(events[2]!["reason"]).toBe("aborted");
    expect(events[2]!["iterations"]).toBe(1);
  });

  it("turn 计数自增", () => {
    const { tracer, dir } = makeTracer();
    tracer.beginTurn("one");
    tracer.endTurn();
    tracer.beginTurn("two");
    tracer.endTurn();
    const events = readDay(dir);
    expect(events[0]!["turn"]).toBe(1);
    expect(events[2]!["turn"]).toBe(2);
  });

  it("scoped 派生子 tracer，sid 为「父:子」", () => {
    const { tracer, dir } = makeTracer();
    tracer.setSid("session_1.jsonl");
    tracer.scoped("subagent").event("subagent", { name: "subagent", status: "spawn" });
    const events = readDay(dir);
    expect(events[0]!["sid"]).toBe("session_1.jsonl:subagent");
  });

  it("写入失败静默（.blh 路径被文件占用时不抛异常）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-tracer-"));
    fs.writeFileSync(path.join(dir, ".blh"), "not a dir");
    const tracer = new Tracer(dir);
    expect(() => {
      tracer.beginTurn("x");
      tracer.event("llm", { provider: "p", model: "m", status: "ok", latency_ms: 1, usage: { promptTokens: 1, completionTokens: 1 } });
      tracer.endTurn();
    }).not.toThrow();
  });
});
