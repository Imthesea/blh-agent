import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ApprovalDecision } from "./types.js";
import type { WebEvent } from "./bridge.js";
import type { ApprovalRequest, PermissionRule } from "./types.js";
import { createLogger } from "@blh/logger";

const log = createLogger("web-server.approval");

const RULES_FILE = "user-rules.json";

export function userRulesPath(workdir: string): string {
  return path.join(workdir, ".blh", RULES_FILE);
}

function isPermissionRule(value: unknown): value is PermissionRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tool === "string" &&
    typeof r.target === "string" &&
    (r.action === "allow" || r.action === "deny" || r.action === "ask")
  );
}

/** 读取 .blh/user-rules.json；文件不存在或非法时返回空数组。 */
export function loadUserRules(workdir: string): PermissionRule[] {
  const file = userRulesPath(workdir);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPermissionRule);
  } catch {
    return [];
  }
}

/** 把一条新规则追加进 .blh/user-rules.json（整体覆写）。 */
export function persistUserRule(workdir: string, rule: PermissionRule): void {
  const file = userRulesPath(workdir);
  mkdirSync(path.dirname(file), { recursive: true });
  const rules = loadUserRules(workdir);
  rules.push(rule);
  writeFileSync(file, JSON.stringify(rules, null, 2) + "\n", "utf8");
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/** 管理待审批请求：web asker 调 ask() 挂起，HTTP 端 resolve() 应答；超时默认拒绝。 */
export class ApprovalCoordinator {
  private seq = 0;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly broadcast: (event: WebEvent) => void) {}

  ask(req: ApprovalRequest): Promise<ApprovalDecision> {
    const requestId = `approval_${++this.seq}`;
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn("approval timed out, auto-denied", { requestId });
        resolve("deny");
      }, 5 * 60 * 1000);
      timer.unref();
      this.pending.set(requestId, { resolve, timer });
      this.broadcast({
        type: "approval_requested",
        requestId,
        tool: req.tool,
        target: req.target,
        args: req.args,
      });
      log.debug("approval requested", { requestId, tool: req.tool });
    });
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    log.debug("approval resolved", { requestId, decision });
    entry.resolve(decision);
    return true;
  }

  /** 拒绝所有待审批请求（用于中断时兜底，避免审批 Promise 一直挂起）。 */
  denyAll(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.resolve("deny");
      log.debug("approval denied by stop", { requestId });
    }
  }
}
