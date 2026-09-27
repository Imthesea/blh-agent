import * as fs from "node:fs";
import * as path from "node:path";
import { foldEvents, readTraceFile, type FoldedTurn } from "./fold.js";
import { usageSummary, type UsageSummary } from "./pricing.js";
import { Tracer, localDate } from "./tracer.js";
import type { TraceEvent } from "./types.js";

export interface TraceOverview {
  usage: UsageSummary;
  today: { turns: number; tools: number; avgLatencyMs: number };
  recentTurns: FoldedTurn[];
}

export interface TraceModule {
  overview(): TraceOverview;
  turns(opts?: { date?: string; sid?: string; limit?: number }): FoldedTurn[];
  events(cursor: number, date?: string): { events: TraceEvent[]; nextCursor: number };
  files(): string[];
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function listDates(workdir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(Tracer.tracesDir(workdir));
  } catch {
    return [];
  }
  return names
    .map((n) => FILE_RE.exec(n)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort()
    .reverse();
}

function readDay(workdir: string, date: string): TraceEvent[] {
  return readTraceFile(path.join(Tracer.tracesDir(workdir), `${date}.jsonl`));
}

export function createTraceModule(workdir: string): TraceModule {
  return {
    overview(): TraceOverview {
      const events = readDay(workdir, localDate());
      const finished = foldEvents(events).filter((t) => t.finished);
      const tools = finished.reduce((n, t) => n + t.toolsUsed, 0);
      const latencies = finished.map((t) => t.latencyMs ?? 0);
      const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
      return {
        usage: usageSummary(workdir),
        today: { turns: finished.length, tools, avgLatencyMs },
        recentTurns: finished.slice(-5).reverse(),
      };
    },

    turns(opts?: { date?: string; sid?: string; limit?: number }): FoldedTurn[] {
      const date = opts?.date ?? localDate();
      let turns = foldEvents(readDay(workdir, date));
      if (opts?.sid !== undefined && opts.sid !== "") {
        turns = turns.filter((t) => t.sid === opts.sid);
      }
      return turns.slice(-(opts?.limit ?? 50)).reverse();
    },

    events(cursor: number, date?: string): { events: TraceEvent[]; nextCursor: number } {
      const file = path.join(Tracer.tracesDir(workdir), `${date ?? localDate()}.jsonl`);
      let content: string;
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        return { events: [], nextCursor: 0 };
      }
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      const total = lines.length;
      if (cursor >= total) {
        return { events: [], nextCursor: total };
      }
      const events: TraceEvent[] = [];
      for (const line of lines.slice(Math.max(0, cursor))) {
        try {
          events.push(JSON.parse(line) as TraceEvent);
        } catch {
          // 坏行跳过
        }
      }
      return { events, nextCursor: total };
    },

    files(): string[] {
      return listDates(workdir);
    },
  };
}
