import { fnmatch } from "../tools/glob.js";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  tool: string;
  target: string;
  action: PermissionAction;
}

export const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", target: "git push --force*", action: "deny" },
  { tool: "bash", target: "rm -rf /*", action: "deny" },
  { tool: "bash", target: "*", action: "ask" },
  { tool: "mcp__*", target: "*", action: "allow" },
  { tool: "connect_mcp", target: "*", action: "ask" },
  { tool: "*", target: "*", action: "allow" },
];

/** 跳过权限询问：仅把 bash 的默认 ask 放宽为 allow，硬拦截(deny)保持不变。 */
export const SKIP_PERMISSIONS_RULES: PermissionRule[] = DEFAULT_RULES.map((rule) =>
  rule.tool === "bash" && rule.action === "ask" ? { ...rule, action: "allow" } : rule,
);

export function matchRule(
  rules: PermissionRule[],
  tool: string,
  target: string,
): PermissionAction {
  for (const rule of rules) {
    if (rule.tool !== "*" && !fnmatch(tool, rule.tool)) continue;
    if (fnmatch(target, rule.target)) return rule.action;
  }
  return "ask";
}

/** 把用户规则插到硬性 deny 之后、默认 ask/allow 之前。 */
export function insertUserRule(rules: PermissionRule[], rule: PermissionRule): void {
  const idx = rules.findIndex((r) => r.action !== "deny");
  rules.splice(idx === -1 ? rules.length : idx, 0, rule);
}

/** 高危删除目标：根目录、家目录、系统目录（含其子路径）。 */
const DANGEROUS_RM_DIRS = [
  "/home",
  "/etc",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/root",
  "/opt",
  "/srv",
  "/mnt",
  "/media",
];

function isDangerousRmTarget(target: string): boolean {
  if (target === "/" || target === "/*") return true;
  const t = target.replace(/\/+$/, "");
  if (t === "") return false;
  if (t === "~" || t.startsWith("~/")) return true;
  return DANGEROUS_RM_DIRS.some((d) => t === d || t.startsWith(d + "/"));
}

function hasForceAndRecursive(flags: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const w of flags) {
    if (w === "--recursive") recursive = true;
    else if (w === "--force") force = true;
    else if (w.startsWith("-") && !w.startsWith("--")) {
      const letters = w.slice(1);
      if (/[rR]/.test(letters)) recursive = true;
      if (/f/.test(letters)) force = true;
    }
  }
  return recursive && force;
}

function isDangerousRm(cmd: string): boolean {
  if (!/^rm\s/.test(cmd)) return false;
  const words = cmd.split(/\s+/).filter(Boolean);
  const rest = words.slice(1);
  if (!hasForceAndRecursive(rest)) return false;
  const targets = rest.filter((w) => !w.startsWith("-"));
  return targets.some(isDangerousRmTarget);
}

function isForcePush(cmd: string): boolean {
  if (!/^git\s+push\b/.test(cmd)) return false;
  if (/(^|\s)(-f|--force|--force-with-lease)(\s|$)/.test(cmd)) return true;
  if (/(^|\s)\+[^\s]+/.test(cmd)) return true;
  return false;
}

function isFindDelete(cmd: string): boolean {
  if (!/^find\s/.test(cmd)) return false;
  const dangerousPath = /^find\s+(\/|\/\*|~)/.test(cmd);
  const hasDelete = /(^|\s)-delete(\s|$)/.test(cmd);
  const hasExecRm = /(^|\s)-exec\s+rm\s+.*(?:-rf|-fr|-r\s+-f|-f\s+-r)/.test(cmd);
  return dangerousPath && (hasDelete || hasExecRm);
}

function isDiskDestroy(cmd: string): boolean {
  if (/^mkfs(\.\S+)?\s+/.test(cmd)) return true;
  if (/^dd\s+.*(^|\s)of=\/dev\//.test(cmd)) return true;
  return false;
}

/**
 * 检测破坏性 bash 命令（不依赖权限规则、skip-permissions 也无法绕过）。
 * 覆盖：高危 rm -rf、git 强制推送、find 删除、mkfs/dd 写设备。
 */
export function isDestructiveBashCommand(command: string): boolean {
  const cmd = command.trim().replace(/\s+/g, " ");
  if (!cmd) return false;
  return isDangerousRm(cmd) || isForcePush(cmd) || isFindDelete(cmd) || isDiskDestroy(cmd);
}
