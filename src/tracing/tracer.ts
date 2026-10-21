import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@blh/logger";
import { summarize } from "../contracts/text.js";
import type { ChatUsage } from "../contracts/types.js";
import { costFor } from "./pricing.js";

const log = createLogger("tracer");

export { summarize };

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

/** 跨实例去重：未知模型只告警一次，避免每个 scoped tracer 重复刷日志。 */
const warnedModels = new Set<string>();

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

  /** 派生一个子 tracer（如 subagent / teammate），sid 记为「父 sid:子名」，便于按会话前缀清理。 */
  scoped(name: string): Tracer {
    const tracer = new Tracer(this.workdir);
    tracer.setSid(`${this.sid}:${name}`);
    return tracer;
  }

  beginTurn(userMessage: string): void {
    this.turn += 1;
    this.turnStart = Date.now();
    this.iterations = 0;
    this.toolsUsed = 0;
    this.costUsd = 0;
    this.event("turn_start", { user_message: summarize(userMessage) });
  }

  endTurn(reason?: string): void {
    this.event("turn_end", {
      ...this.turnStats(),
      ...(reason !== undefined ? { reason } : {}),
    });
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
        if (payload.status !== "error") {
          this.iterations += 1;
        }
        this.recordUsage(payload as unknown as LlmPayload);
      } else if (type === "tool") {
        this.toolsUsed += 1;
      }
      this.writeLine(this.dayFile(), JSON.stringify({ ts: Date.now(), type, sid: this.sid, turn: this.turn, ...payload }) + "\n");
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /** 累加本回合成本；不写 usage.jsonl（trace 的 llm.usage 是唯一 token 源）。 */
  private recordUsage(p: LlmPayload): void {
    if (p.usage == null) return;
    const cost = costFor(p.model, p.usage.promptTokens, p.usage.completionTokens);
    if (cost !== null) {
      this.costUsd += cost;
    } else if (!warnedModels.has(p.model)) {
      warnedModels.add(p.model);
      log.warn("unknown model price, cost will be 0", { model: p.model });
    }
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
