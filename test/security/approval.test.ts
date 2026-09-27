import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Tracer } from "../../src/tracing/tracer.js";
import { makePermissionHook, runInScheduledTurn } from "../../src/security/approval.js";
import {
  DEFAULT_RULES,
  SKIP_PERMISSIONS_RULES,
  type PermissionRule,
} from "../../src/security/rules.js";

describe("makePermissionHook（结构化 asker）", () => {
  it("asker 返回 allow 时放行", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "allow");
    expect(await hook("bash", { command: "ls" })).toBeNull();
  });

  it("asker 返回 deny 时阻断", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "deny");
    expect(await hook("bash", { command: "ls" })).toBe("denied by user");
  });

  it("asker 拿到结构化的 tool/target/args", async () => {
    let received: unknown;
    const hook = makePermissionHook(DEFAULT_RULES, async (req) => {
      received = req;
      return "deny";
    });
    await hook("bash", { command: "npm install" });
    expect(received).toEqual({
      tool: "bash",
      target: "npm install",
      args: { command: "npm install" },
    });
  });

  it("always_allow 写入规则并回调 persistRule，且不覆盖硬性 deny", async () => {
    const rules = [...DEFAULT_RULES];
    const persisted: PermissionRule[] = [];
    const hook = makePermissionHook(rules, async () => "always_allow", (r) => persisted.push(r));

    expect(await hook("bash", { command: "ls -la" })).toBeNull();
    const denyIdx = rules.findIndex((r) => r.action === "deny");
    const userIdx = rules.findIndex((r) => r.target === "ls -la");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeLessThan(userIdx);
    expect(persisted).toEqual([{ tool: "bash", target: "ls -la", action: "allow" }]);
  });

  it("always_allow 且 target 为空时退化为放行、不写规则", async () => {
    const rules = [...DEFAULT_RULES];
    const persisted: PermissionRule[] = [];
    const hook = makePermissionHook(rules, async () => "always_allow", (r) => persisted.push(r));
    expect(await hook("bash", {})).toBeNull();
    expect(persisted).toEqual([]);
    expect(rules.length).toBe(DEFAULT_RULES.length);
  });

  it("scheduled turn 内拒绝交互审批且不调用 asker", async () => {
    const ask = vi.fn().mockResolvedValue("allow");
    const hook = makePermissionHook(DEFAULT_RULES, ask);
    await runInScheduledTurn(async () => {
      await expect(hook("bash", { command: "ls" })).resolves.toBe(
        "denied: cannot request approval from a scheduled turn",
      );
      expect(ask).not.toHaveBeenCalled();
    });
  });

  it("scheduled turn 上下文外不受影响", async () => {
    const ask = vi.fn().mockResolvedValue("allow");
    const hook = makePermissionHook(DEFAULT_RULES, ask);
    expect(await hook("bash", { command: "ls" })).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("文件工具用 path 作为 target 参与规则匹配", async () => {
    const rules: PermissionRule[] = [
      { tool: "write_file", target: "*.env", action: "deny" },
      { tool: "*", target: "*", action: "allow" },
    ];
    const hook = makePermissionHook(rules, async () => "allow");
    expect(await hook("write_file", { path: "prod.env" })).toBe(
      "denied by permission rule (write_file: prod.env)",
    );
  });

  it("无 asker 时返回非交互模式提示", async () => {
    const hook = makePermissionHook(DEFAULT_RULES);
    const result = await hook("bash", { command: "ls" });
    expect(result).toContain("non-interactive");
  });
});

describe("makePermissionHook（破坏性命令硬拦截）", () => {
  it("skip-permissions 下 rm -rf / 仍被 deny 且不调用 asker", async () => {
    const ask = vi.fn().mockResolvedValue("allow");
    const hook = makePermissionHook(SKIP_PERMISSIONS_RULES, ask);
    await expect(hook("bash", { command: "rm -rf /" })).resolves.toBe(
      "denied by permission rule (bash: rm -rf /)",
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it("skip-permissions 下 git push -f 仍被 deny", async () => {
    const ask = vi.fn().mockResolvedValue("allow");
    const hook = makePermissionHook(SKIP_PERMISSIONS_RULES, ask);
    await expect(hook("bash", { command: "git push -f origin main" })).resolves.toBe(
      "denied by permission rule (bash: git push -f origin main)",
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it("skip-permissions 下普通命令照常放行", async () => {
    const ask = vi.fn().mockResolvedValue("deny");
    const hook = makePermissionHook(SKIP_PERMISSIONS_RULES, ask);
    expect(await hook("bash", { command: "ls" })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("makePermissionHook（trace 事件）", () => {
  function readTraceEvents(workdir: string): Array<Record<string, unknown>> {
    const dir = path.join(workdir, ".blh", "traces");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );
  }

  it("用户拒绝时记录 deny/user 事件（source=web）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const hook = makePermissionHook(DEFAULT_RULES, async () => "deny", undefined, tracer, "web");
    expect(await hook("bash", { command: "ls" })).toBe("denied by user");
    const events = readTraceEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "deny",
      rule: "user",
      source: "web",
    });
  });

  it("规则放行时记录 allow/matched_rule 事件（默认 source=cli）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const rules: PermissionRule[] = [{ tool: "bash", target: "ls", action: "allow" }];
    const hook = makePermissionHook(rules, async () => "deny", undefined, tracer);
    expect(await hook("bash", { command: "ls" })).toBeNull();
    expect(readTraceEvents(dir)[0]).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "allow",
      rule: "matched_rule",
      source: "cli",
    });
  });

  it("always_allow 记录 allow/new_rule 事件", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const hook = makePermissionHook([...DEFAULT_RULES], async () => "always_allow", undefined, tracer);
    expect(await hook("bash", { command: "ls -la" })).toBeNull();
    expect(readTraceEvents(dir)[0]).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "allow",
      rule: "new_rule",
      source: "cli",
    });
  });

  it("不传 tracer 时行为不变（向后兼容）", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "allow");
    expect(await hook("bash", { command: "ls" })).toBeNull();
  });

  it("破坏性命令硬拦截记录 deny/destructive_bash 事件", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const hook = makePermissionHook(DEFAULT_RULES, async () => "allow", undefined, tracer);
    expect(await hook("bash", { command: "rm -rf /" })).toBe("denied by permission rule (bash: rm -rf /)");
    const events = readTraceEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]!).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "deny",
      rule: "destructive_bash",
      source: "cli",
    });
  });

  it("scheduled turn 内拒绝记录 deny/scheduled_turn 事件", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const ask = vi.fn().mockResolvedValue("allow");
    const hook = makePermissionHook(DEFAULT_RULES, ask, undefined, tracer);
    await runInScheduledTurn(async () => {
      await expect(hook("bash", { command: "ls" })).resolves.toBe(
        "denied: cannot request approval from a scheduled turn",
      );
    });
    const events = readTraceEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]!).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "deny",
      rule: "scheduled_turn",
      source: "cli",
    });
  });

  it("无 asker 时拒绝记录 deny/no_asker 事件", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const hook = makePermissionHook(DEFAULT_RULES, undefined, undefined, tracer);
    const result = await hook("bash", { command: "ls" });
    expect(result).toContain("non-interactive");
    const events = readTraceEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]!).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "deny",
      rule: "no_asker",
      source: "cli",
    });
  });
});
