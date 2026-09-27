import { request } from "./api.js";

export interface TraceEvent {
  ts: number;
  type: string;
  sid: string;
  turn: number;
  [key: string]: unknown;
}

export interface UsageBucket {
  in: number;
  out: number;
  costUsd: number;
}

export interface UsageSummary {
  total: UsageBucket;
  byDay: Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
}

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

export interface TraceOverview {
  usage: UsageSummary;
  today: { turns: number; tools: number; avgLatencyMs: number };
  recentTurns: FoldedTurn[];
}

export interface TraceEventsPage {
  events: TraceEvent[];
  nextCursor: number;
}

export interface TurnsQuery {
  date?: string;
  sid?: string;
  limit?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s === "" ? "" : `?${s}`;
}

export const traceApi = {
  overview(): Promise<TraceOverview> {
    return request<TraceOverview>("/api/trace/overview");
  },

  turns(opts?: TurnsQuery): Promise<FoldedTurn[]> {
    return request<FoldedTurn[]>(
      `/api/trace/turns${qs({ date: opts?.date, sid: opts?.sid, limit: opts?.limit })}`,
    );
  },

  events(cursor: number, date?: string): Promise<TraceEventsPage> {
    return request<TraceEventsPage>(`/api/trace/events${qs({ cursor, date })}`);
  },

  files(): Promise<string[]> {
    return request<string[]>("/api/trace/files");
  },
};
