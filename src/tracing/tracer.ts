import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@blh/logger";
import type { ChatUsage } from "../core/types.js";
import { costFor } from "./pricing.js";
import type { UsageRecord } from "./types.js";

const log = createLogger("tracer");

/** 截断长文本，保护事件体积。 */
export function summarize(text: string, max = 500): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export function localDate(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface LlmPayload {
  provider: string;
  model: string;
  status: string;
  latency_ms: number;
  usage?: ChatUsage | null;
  [key: string]: unknown;
}

/**
 * 追加式 JSONL tracer。所有 I/O 失败静默（warn 一次），绝不打断主流程。
 */
export class Tracer {
  private sid = "cli";
  private turn = 0;
  private turnStart = 0;
  private iterations = 0;
  private toolsUsed = 0;
  private costUsd = 0;
  private warned = false;

  constructor(private readonly workdir: string) {}

  static tracesDir(workdir: string): string {
    return path.join(workdir, ".blh", "traces");
  }

  setSid(sid: string): void {
    this.sid = sid;
  }

  beginTurn(userMessage: string): void {
    this.turn += 1;
    this.turnStart = Date.now();
    this.iterations = 0;
    this.toolsUsed = 0;
    this.costUsd = 0;
    this.event("turn_start", { user_message: summarize(userMessage) });
  }

  endTurn(): void {
    this.event("turn_end", this.turnStats());
  }

  cancelTurn(reason: string): void {
    this.event("turn_cancelled", { ...this.turnStats(), reason });
  }

  private turnStats(): Record<string, unknown> {
    return {
      latency_ms: Date.now() - this.turnStart,
      iterations: this.iterations,
      tools_used: this.toolsUsed,
      cost_usd: this.costUsd,
    };
  }

  event(type: string, payload: Record<string, unknown>): void {
    try {
      if (type === "llm") {
        this.iterations += 1;
        this.recordUsage(payload as unknown as LlmPayload);
      } else if (type === "tool") {
        this.toolsUsed += 1;
      }
      this.writeLine(this.dayFile(), JSON.stringify({ ts: Date.now(), type, sid: this.sid, turn: this.turn, ...payload }) + "\n");
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private recordUsage(p: LlmPayload): void {
    if (p.usage == null) return;
    const cost = costFor(p.model, p.usage.promptTokens, p.usage.completionTokens);
    if (cost !== null) this.costUsd += cost;
    const rec: UsageRecord = {
      ts: Date.now(),
      sid: this.sid,
      provider: p.provider,
      model: p.model,
      in: p.usage.promptTokens,
      out: p.usage.completionTokens,
    };
    this.writeLine(path.join(this.workdir, ".blh", "usage.jsonl"), JSON.stringify(rec) + "\n");
  }

  private dayFile(): string {
    return path.join(Tracer.tracesDir(this.workdir), `${localDate()}.jsonl`);
  }

  private writeLine(file: string, line: string): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    log.warn("tracing disabled after write failure", { error: String(err) });
  }
}
