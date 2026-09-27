export interface TraceEvent {
  ts: number;
  type: string;
  sid: string;
  turn: number;
  [key: string]: unknown;
}

export interface UsageRecord {
  ts: number;
  sid: string;
  provider: string;
  model: string;
  in: number;
  out: number;
}
