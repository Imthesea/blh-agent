/** GoalController:session 级 goal + Stop hook 决策(异步评估)。 */
import type { ChatMessage } from "../contracts/types.js";
import type { GoalEvaluator } from "./evaluator.js";
import type { StopDecision } from "../contracts/goals.js";
import { GoalError, type GoalState } from "./types.js";
const MAX_GOAL_LENGTH = 4000;
const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;

export class GoalController {
  active: GoalState | null = null;
  private lastStatus: Record<string, unknown> | null = null;
  private consecutiveBlocks = 0;

  constructor(
    readonly evaluator: GoalEvaluator,
    readonly blockCap = DEFAULT_STOP_HOOK_BLOCK_CAP,
    readonly events: Record<string, unknown>[] = [],
  ) {
    if (blockCap < 1) throw new GoalError("block_cap must be at least 1");
  }

  beginQuery(): void {
    this.consecutiveBlocks = 0;
  }

  setGoal(condition: string, tokensAtStart = 0): GoalState {
    const trimmed = condition.trim();
    if (!trimmed) throw new GoalError("goal condition cannot be empty");
    if (trimmed.length > MAX_GOAL_LENGTH) {
      throw new GoalError(`goal condition cannot exceed ${MAX_GOAL_LENGTH} characters`);
    }
    if (this.active !== null) {
      this.record(false, false, false, "replaced by a new goal");
    }
    this.active = {
      condition: trimmed,
      iterations: 0,
      setAt: Date.now() / 1000,
      tokensAtStart,
    };
    this.consecutiveBlocks = 0;
    this.record(true, false, false, "goal set");
    return this.active;
  }

  clear(reason = "cleared"): string {
    if (this.active === null) return "No goal set";
    const condition = this.active.condition;
    this.record(false, false, false, reason);
    this.active = null;
    this.consecutiveBlocks = 0;
    return `Goal cleared: ${condition}`;
  }

  status(currentTokens = 0): string {
    if (this.active === null) {
      if (this.lastStatus?.met === true) {
        return (
          `Goal achieved: ${String(this.lastStatus.condition ?? "")}\n` +
          `Reason: ${String(this.lastStatus.reason ?? "")}`
        );
      }
      if (this.lastStatus?.failed === true) {
        return (
          `Goal failed: ${String(this.lastStatus.condition ?? "")}\n` +
          `Reason: ${String(this.lastStatus.reason ?? "")}`
        );
      }
      return "No goal set";
    }
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - this.active.setAt));
    const spent = Math.max(0, currentTokens - this.active.tokensAtStart);
    const lines = [
      `Goal active: ${this.active.condition}`,
      `Elapsed: ${elapsed}s`,
      `Evaluations: ${this.active.iterations}`,
      `Tokens: ${spent}`,
    ];
    if (this.active.lastReason) lines.push(`Last reason: ${this.active.lastReason}`);
    return lines.join("\n");
  }

  async evaluateAfterTurn(messages: ChatMessage[], backgroundRunning = false): Promise<StopDecision> {
    if (this.active === null) return { action: "allow", reason: "" };
    if (backgroundRunning) {
      return { action: "defer", reason: "background work is still running" };
    }

    const state = this.active;
    let evaluation;
    try {
      evaluation = await this.evaluator.evaluate(state.condition, messages);
    } catch (error) {
      const reason = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
      state.lastReason = reason;
      this.record(true, false, false, reason);
      return { action: "error", reason };
    }

    state.iterations += 1;
    state.lastReason = evaluation.reason;

    if (evaluation.ok) {
      this.record(false, true, false, evaluation.reason);
      this.active = null;
      this.consecutiveBlocks = 0;
      return { action: "achieved", reason: evaluation.reason };
    }

    if (evaluation.impossible) {
      this.record(false, false, true, evaluation.reason);
      this.active = null;
      this.consecutiveBlocks = 0;
      return { action: "failed", reason: evaluation.reason };
    }

    this.consecutiveBlocks += 1;
    this.record(true, false, false, evaluation.reason);
    if (this.consecutiveBlocks > this.blockCap) {
      return {
        action: "limit",
        reason: `goal remains active, but the Stop hook blocked ${this.blockCap} consecutive turns`,
      };
    }
    return { action: "block", reason: evaluation.reason };
  }

  private record(active: boolean, met: boolean, failed: boolean, reason: string): void {
    const state = this.active;
    const event: Record<string, unknown> = {
      type: "goal_status",
      condition: state?.condition ?? "",
      active,
      met,
      failed,
      reason,
      iterations: state?.iterations ?? 0,
      duration: Math.max(0, Date.now() / 1000 - (state?.setAt ?? 0)),
    };
    this.events.push(event);
    this.lastStatus = event;
  }

  static restore(
    evaluator: GoalEvaluator,
    events: Record<string, unknown>[],
    blockCap = DEFAULT_STOP_HOOK_BLOCK_CAP,
  ): GoalController {
    const controller = new GoalController(evaluator, blockCap, [...events]);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] ?? {};
      if (event.type !== "goal_status") continue;
      controller.lastStatus = { ...event };
      if (event.active === true) {
        controller.active = {
          condition: String(event.condition ?? ""),
          iterations: 0,
          setAt: Date.now() / 1000,
          tokensAtStart: 0,
        };
      }
      break;
    }
    return controller;
  }
}
