import * as fs from "node:fs";
import type { TraceEvent } from "./types.js";

export interface FoldedTurn {
  turn: number;
  sid: string;
  userMessage: string;
  startedAt: number;
  finished: boolean;
  cancelled: boolean;
  latencyMs: number | null;
  iterations: number;
  toolsUsed: number;
  costUsd: number;
  events: TraceEvent[];
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** 把事件流折叠为 turn 视图（按 sid#turn 分组，保持文件内顺序）。 */
export function foldEvents(events: TraceEvent[]): FoldedTurn[] {
  const turns = new Map<string, FoldedTurn>();
  for (const e of events) {
    const key = `${e.sid}#${e.turn}`;
    let t = turns.get(key);
    if (t === undefined) {
      t = {
        turn: e.turn,
        sid: e.sid,
        userMessage: "",
        startedAt: e.ts,
        finished: false,
        cancelled: false,
        latencyMs: null,
        iterations: 0,
        toolsUsed: 0,
        costUsd: 0,
        events: [],
      };
      turns.set(key, t);
    }
    t.events.push(e);
    if (e.type === "turn_start") {
      t.userMessage = typeof e["user_message"] === "string" ? e["user_message"] : "";
      t.startedAt = e.ts;
    } else if (e.type === "turn_end" || e.type === "turn_cancelled") {
      t.finished = true;
      t.cancelled = e.type === "turn_cancelled";
      t.latencyMs = num(e["latency_ms"]);
      t.iterations = num(e["iterations"]);
      t.toolsUsed = num(e["tools_used"]);
      t.costUsd = num(e["cost_usd"]);
    }
  }
  return [...turns.values()];
}

export function readTraceFile(file: string): TraceEvent[] {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // 坏行跳过
    }
  }
  return events;
}
