export interface TraceEvent {
  ts: number;
  type: string;
  sid: string;
  turn: number;
  [key: string]: unknown;
}
