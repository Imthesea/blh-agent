export type GoalCommand = "status" | "clear" | "set";

export const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/** 解析 /goal 前缀命令；不是 goal 命令时返回 null。 */
export function parseGoalCommand(text: string): GoalCommand | null {
  const stripped = text.trim();
  if (stripped === "/goal") return "status";
  if (stripped.startsWith("/goal ")) {
    const argument = stripped.slice(6).trim();
    if (CLEAR_ALIASES.has(argument.toLowerCase())) return "clear";
    return "set";
  }
  return null;
}

export type StopAction =
  | "allow"
  | "defer"
  | "achieved"
  | "failed"
  | "limit"
  | "error"
  | "block";

export interface StopDecision {
  action: StopAction;
  reason: string;
}
