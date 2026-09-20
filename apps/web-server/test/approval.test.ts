import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCoordinator, loadUserRules, persistUserRule, userRulesPath } from "../src/approval.js";
import type { WebEvent } from "../src/bridge.js";

describe("user rules 持久化", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-rules-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("无文件时返回空数组", () => {
    expect(loadUserRules(tmpDir)).toEqual([]);
  });

  it("写入后能读回并追加", () => {
    persistUserRule(tmpDir, { tool: "bash", target: "ls", action: "allow" });
    persistUserRule(tmpDir, { tool: "bash", target: "cat", action: "allow" });
    expect(loadUserRules(tmpDir)).toEqual([
      { tool: "bash", target: "ls", action: "allow" },
      { tool: "bash", target: "cat", action: "allow" },
    ]);
  });

  it("非法条目被过滤", () => {
    mkdirSync(path.dirname(userRulesPath(tmpDir)), { recursive: true });
    writeFileSync(
      userRulesPath(tmpDir),
      JSON.stringify([{ tool: "bash" }, "oops", { tool: "bash", target: "ls", action: "allow" }]),
    );
    expect(loadUserRules(tmpDir)).toEqual([{ tool: "bash", target: "ls", action: "allow" }]);
  });
});

describe("ApprovalCoordinator", () => {
  it("ask 广播审批事件，resolve 应答对应请求", async () => {
    const events: WebEvent[] = [];
    const coordinator = new ApprovalCoordinator((e) => events.push(e));
    const promise = coordinator.ask({ tool: "bash", target: "ls", args: { command: "ls" } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "approval_requested", tool: "bash", target: "ls" });
    const requestId = (events[0] as { requestId: string }).requestId;

    expect(coordinator.resolve(requestId, "always_allow")).toBe(true);
    await expect(promise).resolves.toBe("always_allow");
  });

  it("resolve 未知 id 返回 false", () => {
    const coordinator = new ApprovalCoordinator(() => {});
    expect(coordinator.resolve("nope", "allow")).toBe(false);
  });

  it("超时自动拒绝", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator(() => {});
      const promise = coordinator.ask({ tool: "bash", target: "ls", args: {} });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await expect(promise).resolves.toBe("deny");
    } finally {
      vi.useRealTimers();
    }
  });

  it("denyAll 拒绝所有待审批请求", async () => {
    const coordinator = new ApprovalCoordinator(() => {});
    const p1 = coordinator.ask({ tool: "bash", target: "ls", args: {} });
    const p2 = coordinator.ask({ tool: "bash", target: "rm", args: {} });
    coordinator.denyAll();
    await expect(p1).resolves.toBe("deny");
    await expect(p2).resolves.toBe("deny");
  });
});
