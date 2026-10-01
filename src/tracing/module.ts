import * as fs from "node:fs";
import type { FoldedTurn } from "./fold.js";
import type { UsageSummary } from "./pricing.js";
import { TraceStore } from "./store.js";
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

export function createTraceModule(workdir: string): TraceModule {
  // 所有读取走 Store：增量读文件、缓存解析与折叠结果，
  // 重复调用成本稳定，不随 trace 文件增长而膨胀。
  const store = new TraceStore(workdir);
  return {
    overview(): TraceOverview {
      const finished = store.turns(localDate()).filter((t) => t.finished);
      const tools = finished.reduce((n, t) => n + t.toolsUsed, 0);
      const latencies = finished.map((t) => t.latencyMs ?? 0);
      const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
      return {
        usage: store.usage(),
        today: { turns: finished.length, tools, avgLatencyMs },
        recentTurns: finished.slice(-5).reverse(),
      };
    },

    turns(opts?: { date?: string; sid?: string; limit?: number }): FoldedTurn[] {
      const date = opts?.date ?? localDate();
      let turns = store.turns(date);
      if (opts?.sid !== undefined && opts.sid !== "") {
        turns = turns.filter((t) => t.sid === opts.sid);
      }
      return turns.slice(-(opts?.limit ?? 50)).reverse();
    },

    events(cursor: number, date?: string): { events: TraceEvent[]; nextCursor: number } {
      return store.events(date ?? localDate(), cursor);
    },

    files(): string[] {
      return listDates(workdir);
    },
  };
}
