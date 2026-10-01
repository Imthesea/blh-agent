import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
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

/** dream 轮上下文：携带 workdir 与 memory 目录，用于写白名单判定。 */
export interface DreamContext {
  workdir: string;
  memoryDir: string;
}

const dreamTurnStorage = new AsyncLocalStorage<DreamContext>();

/** dream 轮可申请写白名单的工具集合。 */
const DREAM_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/** 在 dream-turn 上下文中执行：叠加 scheduled 语义（禁交互审批）+ dream 写白名单。 */
export function runInDreamTurn<T>(ctx: DreamContext, fn: () => Promise<T>): Promise<T> {
  return scheduledTurnStorage.run(true, () => dreamTurnStorage.run(ctx, fn));
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
    const dreamCtx = dreamTurnStorage.getStore();
    if (dreamCtx !== undefined && DREAM_WRITE_TOOLS.has(tool)) {
      const resolved = path.resolve(dreamCtx.workdir, target);
      const rel = path.relative(dreamCtx.memoryDir, resolved);
      const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      if (!inside) {
        log.warn("denied by dream whitelist", { tool, target });
        tracer?.event("approval", { tool, decision: "deny", rule: "dream_whitelist", source });
        return `denied by permission rule (${tool}: ${target}) — dream turn may only write inside .memory/`;
      }
      tracer?.event("approval", { tool, decision: "allow", rule: "dream_whitelist", source });
      return null;
    }
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
