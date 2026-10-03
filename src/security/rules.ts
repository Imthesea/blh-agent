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

const WINDOWS_SYSTEM_DIRS = [
  "c:/windows",
  "c:/program files",
  "c:/program files (x86)",
  "c:/programdata",
  "c:/users",
];
const WINDOWS_ENV_DIRS = new Set([
  "%userprofile%",
  "%programfiles%",
  "%programfiles(x86)%",
  "%programdata%",
  "%systemroot%",
]);

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (quote !== "") {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
  }
  segments.push(current.trim());
  return segments.filter(Boolean);
}

function splitWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of segment) {
    if (quote !== "") {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") words.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") words.push(current);
  return words;
}

function normalizeCommand(command: string | undefined): string {
  return (command ?? "").toLowerCase().replace(/\.exe$/, "");
}

function isDangerousDeleteTarget(target: string): boolean {
  if (/^\/+\*?$/.test(target)) return true;
  const trimmed = target.replace(/[\\/]+$/, "");
  if (trimmed === "") return false;
  if (
    trimmed === "." ||
    trimmed === "./*" ||
    trimmed === ".\\*" ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    trimmed === "$HOME" ||
    trimmed === "${HOME}"
  ) {
    return true;
  }
  if (/^[a-z]:$/i.test(trimmed) || /^[a-z]:[\\/]\*$/i.test(trimmed)) return true;
  if (
    /^%systemdrive%$/i.test(trimmed) ||
    /^%systemdrive%[\\/]\*$/i.test(trimmed) ||
    WINDOWS_ENV_DIRS.has(trimmed.toLowerCase()) ||
    /^%userprofile%[\\/]\*$/i.test(trimmed)
  ) {
    return true;
  }
  const windowsPath = trimmed.replace(/\\/g, "/").toLowerCase();
  if (WINDOWS_SYSTEM_DIRS.some((dir) => windowsPath === dir || windowsPath === `${dir}/*`)) {
    return true;
  }
  const posixPath = trimmed.replace(/\\/g, "/");
  return DANGEROUS_RM_DIRS.some((dir) => posixPath === dir || posixPath.startsWith(`${dir}/`));
}

function hasRmRecursiveFlag(args: string[]): boolean {
  return args.some((arg) => {
    if (arg === "--recursive") return true;
    return arg.startsWith("-") && !arg.startsWith("--") && /[rR]/.test(arg.slice(1));
  });
}

function isDangerousRm(words: string[]): boolean {
  if (normalizeCommand(words[0]) !== "rm") return false;
  const args = words.slice(1);
  if (!hasRmRecursiveFlag(args)) return false;
  return args.filter((arg) => !arg.startsWith("-")).some(isDangerousDeleteTarget);
}

function isDangerousWindowsDelete(words: string[]): boolean {
  const command = normalizeCommand(words[0]);
  if (!["rd", "rmdir", "del", "erase"].includes(command)) return false;
  const args = words.slice(1);
  if (!args.some((arg) => /^\/s$/i.test(arg))) return false;
  return args.filter((arg) => !arg.startsWith("/")).some(isDangerousDeleteTarget);
}

function isDangerousPowerShellRemove(words: string[]): boolean {
  if (normalizeCommand(words[0]) !== "remove-item") return false;
  const args = words.slice(1);
  if (!args.some((arg) => /^-(?:recurse|r)$/i.test(arg))) return false;
  return args.filter((arg) => !arg.startsWith("-")).some(isDangerousDeleteTarget);
}

function powerShellCommandSegments(words: string[]): string[] | null {
  if (!["powershell", "pwsh"].includes(normalizeCommand(words[0]))) return null;
  const commandIndex = words.findIndex((word) => /^-(?:command|c)$/i.test(word));
  if (commandIndex === -1) return null;
  return splitCommandSegments(words.slice(commandIndex + 1).join(" "));
}

function isForcePush(cmd: string): boolean {
  if (!/^git\s+push\b/.test(cmd)) return false;
  if (/(^|\s)(-f|--force|--force-with-lease)(\s|$)/.test(cmd)) return true;
  if (/(^|\s)\+[^\s]+/.test(cmd)) return true;
  return false;
}

function isFindDelete(cmd: string): boolean {
  if (!/^find\s/.test(cmd)) return false;
  const words = splitWords(cmd);
  const target = words[1] ?? "";
  const dangerousPath = target !== "." && isDangerousDeleteTarget(target);
  const hasDelete = /(^|\s)-delete(\s|$)/.test(cmd);
  const hasExecRm = /(^|\s)-exec\s+rm\s+.*(?:-rf|-fr|-r\s+-f|-f\s+-r)/.test(cmd);
  return dangerousPath && (hasDelete || hasExecRm);
}

function isDiskDestroy(cmd: string): boolean {
  if (/^mkfs(\.\S+)?\s+/.test(cmd)) return true;
  if (/^dd\s+.*(^|\s)of=\/dev\//.test(cmd)) return true;
  if (/^format(\.\S+)?\s+[a-z]:/i.test(cmd)) return true;
  return false;
}

function isDestructiveSegment(segment: string): boolean {
  const words = splitWords(segment);
  const nestedSegments = powerShellCommandSegments(words);
  if (nestedSegments !== null && nestedSegments.some(isDestructiveSegment)) return true;
  return (
    isDangerousRm(words) ||
    isDangerousWindowsDelete(words) ||
    isDangerousPowerShellRemove(words) ||
    isForcePush(segment) ||
    isFindDelete(segment) ||
    isDiskDestroy(segment)
  );
}

/**
 * 检测破坏性 bash 命令（不依赖权限规则、skip-permissions 也无法绕过）。
 * 覆盖：高危 rm -rf、git 强制推送、find 删除、mkfs/dd 写设备。
 */
export function isDestructiveBashCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  return splitCommandSegments(cmd).some(isDestructiveSegment);
}
