import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TraceStore } from "../../src/tracing/store.js";
import { localDate } from "../../src/tracing/tracer.js";

function setup(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-store-"));
  const traces = path.join(dir, ".blh", "traces");
  fs.mkdirSync(traces, { recursive: true });
  return { dir, file: path.join(traces, `${localDate()}.jsonl`) };
}

function usageFile(dir: string): string {
  return path.join(dir, ".blh", "usage.jsonl");
}

function appendLines(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.join("\n") + "\n");
}

const TURN = [
  JSON.stringify({ ts: 1000, type: "turn_start", sid: "s1", turn: 1, user_message: "hi" }),
  JSON.stringify({ ts: 1100, type: "llm", sid: "s1", turn: 1, provider: "deepseek", model: "deepseek-chat", status: "ok", latency_ms: 50 }),
  JSON.stringify({ ts: 1200, type: "tool", sid: "s1", turn: 1, tool: "bash", args_summary: "ls", latency_ms: 10, status: "ok", output_summary: "x" }),
  JSON.stringify({ ts: 1300, type: "turn_end", sid: "s1", turn: 1, latency_ms: 300, iterations: 1, tools_used: 1, cost_usd: 0.001 }),
];

describe("events 增量读", () => {
  it("文件不存在返回空", () => {
    const { dir } = setup();
    const s = new TraceStore(dir);
    expect(s.events(localDate(), 0)).toEqual({ events: [], nextCursor: 0 });
  });

  it("首次全量，之后只读新增字节", () => {
    const { dir, file } = setup();
    appendLines(file, TURN);
    const s = new TraceStore(dir);
    const first = s.events(localDate(), 0);
    expect(first.events.length).toBe(4);
    expect(first.nextCursor).toBe(4);
    const before = s.stats().bytesRead;

    const extra = JSON.stringify({ ts: 1400, type: "memory", sid: "s1", turn: 1 });
    appendLines(file, [extra]);
    const second = s.events(localDate(), 4);
    expect(second.events.length).toBe(1);
    expect(second.nextCursor).toBe(5);
    // 只读了新增那一行的字节，没有重读全文
    expect(s.stats().bytesRead - before).toBe(Buffer.byteLength(extra + "\n"));
  });

  it("没变化时不读文件", () => {
    const { dir, file } = setup();
    appendLines(file, TURN);
    const s = new TraceStore(dir);
    s.events(localDate(), 0);
    const before = s.stats().bytesRead;
    s.events(localDate(), 0);
    expect(s.stats().bytesRead).toBe(before);
  });

  it("半行暂存，补全后再返回", () => {
    const { dir, file } = setup();
    // 写入一行完整 + 半行（无尾换行）
    fs.writeFileSync(file, TURN[0]! + "\n" + TURN[1]!.slice(0, 30));
    const s = new TraceStore(dir);
    const first = s.events(localDate(), 0);
    expect(first.events.length).toBe(1);
    expect(first.nextCursor).toBe(1);

    // 补全第二行
    fs.appendFileSync(file, TURN[1]!.slice(30) + "\n");
    const second = s.events(localDate(), 1);
    expect(second.events.length).toBe(1);
    expect((second.events[0] as { type: string }).type).toBe("llm");
    expect(second.nextCursor).toBe(2);
  });

  it("坏行占位：计入 cursor 但不出现在结果", () => {
    const { dir, file } = setup();
    appendLines(file, [TURN[0]!, "not-json{{{", TURN[2]!, TURN[3]!]);
    const s = new TraceStore(dir);
    const all = s.events(localDate(), 0);
    expect(all.events.length).toBe(3);
    expect(all.nextCursor).toBe(4);
    const rest = s.events(localDate(), 2);
    expect(rest.events.map((e) => (e as { type: string }).type)).toEqual(["tool", "turn_end"]);
  });

  it("cursor 越界归位", () => {
    const { dir, file } = setup();
    appendLines(file, TURN);
    const s = new TraceStore(dir);
    expect(s.events(localDate(), 99)).toEqual({ events: [], nextCursor: 4 });
  });
});

describe("文件重置", () => {
  it("文件被截断后从头重读", () => {
    const { dir, file } = setup();
    appendLines(file, TURN);
    const s = new TraceStore(dir);
    expect(s.events(localDate(), 0).nextCursor).toBe(4);

    fs.writeFileSync(file, TURN[0]! + "\n");
    const r = s.events(localDate(), 0);
    expect(r.events.length).toBe(1);
    expect(r.nextCursor).toBe(1);
  });

  it("文件删除后重建，旧缓存作废", () => {
    const { dir, file } = setup();
    appendLines(file, [TURN[0]!, TURN[1]!]);
    const s = new TraceStore(dir);
    expect(s.events(localDate(), 0).nextCursor).toBe(2);

    fs.rmSync(file);
    expect(s.events(localDate(), 0)).toEqual({ events: [], nextCursor: 0 });

    // 重建一个更长的文件，不能从旧 offset 中间读
    appendLines(file, TURN);
    const r = s.events(localDate(), 0);
    expect(r.events.length).toBe(4);
    expect(r.nextCursor).toBe(4);
  });
});

describe("turns 折叠缓存", () => {
  it("无新增时不重复 fold，有新增才重算", () => {
    const { dir, file } = setup();
    appendLines(file, TURN);
    const s = new TraceStore(dir);
    expect(s.turns(localDate()).length).toBe(1);
    s.turns(localDate());
    expect(s.stats().folds).toBe(1);

    appendLines(file, [JSON.stringify({ ts: 2000, type: "turn_start", sid: "s1", turn: 2, user_message: "again" })]);
    expect(s.turns(localDate()).length).toBe(2);
    expect(s.stats().folds).toBe(2);
  });

  it("折叠结果与 foldEvents 语义一致", () => {
    const { dir, file } = setup();
    appendLines(file, TURN);
    const s = new TraceStore(dir);
    const t = s.turns(localDate())[0]!;
    expect(t.finished).toBe(true);
    expect(t.userMessage).toBe("hi");
    expect(t.toolsUsed).toBe(1);
    expect(t.latencyMs).toBe(300);
    expect(t.events.length).toBe(4);
  });
});

describe("usage 增量聚合", () => {
  const REC1 = JSON.stringify({ ts: 1250, sid: "s1", provider: "deepseek", model: "deepseek-chat", in: 100, out: 50 });
  const REC2 = JSON.stringify({ ts: 1300, sid: "s1", provider: "deepseek", model: "qwen-plus", in: 30, out: 10 });

  it("追加记录只累加新增部分，不翻倍", () => {
    const { dir } = setup();
    appendLines(usageFile(dir), [REC1]);
    const s = new TraceStore(dir);
    expect(s.usage().total.in).toBe(100);

    appendLines(usageFile(dir), [REC2]);
    const u = s.usage();
    expect(u.total.in).toBe(130);
    expect(u.total.out).toBe(60);
    expect(Object.keys(u.byModel).sort()).toEqual(["deepseek-chat", "qwen-plus"]);
  });

  it("usage 文件不存在返回全零", () => {
    const { dir } = setup();
    const s = new TraceStore(dir);
    const u = s.usage();
    expect(u.total).toEqual({ in: 0, out: 0, costUsd: 0 });
  });
});

describe("多日期缓存", () => {
  it("各日期独立增量", () => {
    const { dir } = setup();
    const traces = path.join(dir, ".blh", "traces");
    appendLines(path.join(traces, "2026-09-26.jsonl"), [TURN[0]!]);
    appendLines(path.join(traces, "2026-09-27.jsonl"), [TURN[0]!, TURN[1]!]);
    const s = new TraceStore(dir);
    expect(s.events("2026-09-26", 0).nextCursor).toBe(1);
    expect(s.events("2026-09-27", 0).nextCursor).toBe(2);
    appendLines(path.join(traces, "2026-09-26.jsonl"), [TURN[1]!]);
    expect(s.events("2026-09-26", 1).nextCursor).toBe(2);
    // 另一天不受影响
    expect(s.events("2026-09-27", 2)).toEqual({ events: [], nextCursor: 2 });
  });

  it("LRU 淘汰后重读结果仍正确", () => {
    const { dir } = setup();
    const traces = path.join(dir, ".blh", "traces");
    const dates: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const d = `2026-09-${String(i).padStart(2, "0")}`;
      dates.push(d);
      appendLines(path.join(traces, `${d}.jsonl`), [TURN[0]!]);
    }
    const s = new TraceStore(dir);
    for (const d of dates) s.events(d, 0);
    // 第 1 天已被淘汰，再访问重读，结果不变
    const r = s.events(dates[0]!, 0);
    expect(r.events.length).toBe(1);
    expect(r.nextCursor).toBe(1);
  });
});
