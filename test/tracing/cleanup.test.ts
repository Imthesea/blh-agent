import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeSessionArtifacts } from "../../src/tracing/cleanup.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

describe("removeSessionArtifacts", () => {
  it("按 sid / sid 前缀清理 trace 与 log，保留他人与坏行", () => {
    const tracesDir = path.join(dir, ".blh", "traces");
    const logsDir = path.join(dir, ".blh", "logs");
    mkdirSync(tracesDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    const traceFile = path.join(tracesDir, "2026-09-26.jsonl");
    writeFileSync(traceFile, [
      JSON.stringify({ ts: 1, type: "turn_start", sid: "session_a.jsonl", turn: 1 }),
      JSON.stringify({ ts: 2, type: "subagent", sid: "session_a.jsonl:subagent", turn: 1 }),
      JSON.stringify({ ts: 3, type: "turn_start", sid: "session_b.jsonl", turn: 1 }),
      "not-json{{{",
    ].join("\n") + "\n");

    const logFile = path.join(logsDir, "blh-2026-09-26.log");
    writeFileSync(logFile, [
      JSON.stringify({ time: "x", level: "error", module: "x", msg: "boom", sid: "session_a.jsonl", fields: {} }),
      JSON.stringify({ time: "x", level: "error", module: "x", msg: "other", sid: "session_b.jsonl", fields: {} }),
      JSON.stringify({ time: "x", level: "info", module: "x", msg: "no-sid", fields: {} }),
      "bad-log-line",
    ].join("\n") + "\n");

    removeSessionArtifacts(dir, "session_a.jsonl");

    const traceLines = lines(traceFile);
    expect(traceLines).toHaveLength(2);
    expect(traceLines[0]).toContain("session_b.jsonl");
    expect(traceLines[1]).toBe("not-json{{{");

    const logLines = lines(logFile);
    expect(logLines).toHaveLength(3);
    expect(logLines[0]).toContain("session_b.jsonl");
    expect(logLines[1]).toContain("no-sid");
    expect(logLines[2]).toBe("bad-log-line");
  });

  it("目录不存在不抛错（幂等）", () => {
    expect(() => removeSessionArtifacts(dir, "session_a.jsonl")).not.toThrow();
  });
});
