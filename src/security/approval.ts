import { AsyncLocalStorage } from "node:async_hooks";
import type { PermissionRule } from "./rules.js";
import { insertUserRule, isDestructiveBashCommand, matchRule } from "./rules.js";
import { createLogger } from "@blh/logger";
import type { Tracer } from "../tracing/tracer.js";

const log = createLogger("security.approval");

export interface ApprovalRequest {
  tool: string;
  target: string;
  args: Record<string, unknown>;
}

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export type ApprovalAsker = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** PreToolUse hook：返回 null 放行；返回字符串则阻断并作为工具结果 */
export type PermissionHook = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string | null>;

/** scheduled turn 上下文：随异步调用链传播，隔离并发（替代进程级可变单例）。 */
const scheduledTurnStorage = new AsyncLocalStorage<boolean>();

/** 在 scheduled-turn 上下文中执行回调，回调内申请交互审批会被拒绝。 */
export function runInScheduledTurn<T>(fn: () => Promise<T>): Promise<T> {
  return scheduledTurnStorage.run(true, fn);
}

export function makePermissionHook(
  rules: PermissionRule[],
  ask?: ApprovalAsker,
  persistRule?: (rule: PermissionRule) => void,
  tracer?: Tracer,
  source: "cli" | "web" = "cli",
): PermissionHook {
  const hasAsker = ask !== undefined;
  const asker: ApprovalAsker = ask ?? (async () => "deny");

  return async (tool, args) => {
    const target =
      (typeof args.command === "string" && args.command) ||
      (typeof args.path === "string" && args.path) ||
      "";
    if (tool === "bash" && isDestructiveBashCommand(target)) {
      log.warn("denied by rule (destructive)", { tool, target });
      tracer?.event("approval", { tool, decision: "deny", rule: "destructive_bash", source });
      return `denied by permission rule (${tool}: ${target})`;
    }
    const action = matchRule(rules, tool, target);
    if (action === "allow") {
      tracer?.event("approval", { tool, decision: "allow", rule: "matched_rule", source });
      return null;
    }
    if (action === "deny") {
      log.warn("denied by rule", { tool, target });
      tracer?.event("approval", { tool, decision: "deny", rule: "matched_rule", source });
      return `denied by permission rule (${tool}: ${target})`;
    }
    if (scheduledTurnStorage.getStore() === true) {
      tracer?.event("approval", { tool, decision: "deny", rule: "scheduled_turn", source });
      return "denied: cannot request approval from a scheduled turn";
    }
    const decision = await asker({ tool, target, args });
    if (decision === "deny") {
      tracer?.event("approval", { tool, decision: "deny", rule: hasAsker ? "user" : "no_asker", source });
      if (!hasAsker) {
        return "denied: no approval asker available (non-interactive mode); use --dangerously-skip-permissions to allow non-destructive bash";
      }
      log.warn("denied by user", { tool, target });
      return "denied by user";
    }
    tracer?.event("approval", {
      tool,
      decision: "allow",
      rule: decision === "always_allow" && target !== "" ? "new_rule" : "user",
      source,
    });
    if (decision === "always_allow" && target !== "") {
      const rule: PermissionRule = { tool, target, action: "allow" };
      insertUserRule(rules, rule);
      persistRule?.(rule);
      log.debug("always allowed", { tool, target });
    } else {
      log.debug("approved", { tool, target });
    }
    return null;
  };
}
