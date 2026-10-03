import { describe, expect, it } from "vitest";
import { BackgroundManager } from "../../src/jobs/background.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function makeManager(): BackgroundManager {
  return new BackgroundManager(process.cwd());
}

function makeSlowWorkdir(): string {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "background-test-"));
  writeFileSync(path.join(workdir, "slow.js"), "setInterval(() => {}, 60000);");
  return workdir;
}

async function waitStatus(
  manager: BackgroundManager,
  taskId: string,
  status: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.tasks[taskId]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${taskId} to reach ${status}`);
}

describe("BackgroundManager", () => {
  it("start returns bg id and tracks running", () => {
    const manager = makeManager();
    const bgId = manager.start("echo hi");
    expect(bgId.startsWith("bg_")).toBe(true);
    expect(manager.tasks[bgId]?.status).toBe("running");
  });

  it("start rejects empty command", () => {
    expect(() => makeManager().start("   ")).toThrow(Error);
  });
  it("constructor rejects invalid limits", () => {
    expect(() => new BackgroundManager(process.cwd(), 0)).toThrow(TypeError);
    expect(() => new BackgroundManager(process.cwd(), 120, -1)).toThrow(RangeError);
  });

  it("collect returns completed notification", async () => {
    const manager = makeManager();
    const bgId = manager.start("echo hello");
    await waitStatus(manager, bgId, "completed");
    const notifications = manager.collect();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(`<task_id>${bgId}</task_id>`);
    expect(notifications[0]).toContain("<status>completed</status>");
    expect(notifications[0]).toContain("hello");
  });

  it("collect empty when nothing done", () => {
    expect(makeManager().collect()).toEqual([]);
  });

  it("hasRunning reports active tasks", () => {
    const manager = makeManager();
    expect(manager.hasRunning()).toBe(false);
    manager.start("echo hi");
    expect(manager.hasRunning()).toBe(true);
  });

  it("failed command marks failed", async () => {
    const manager = makeManager();
    const bgId = manager.start("exit 1");
    await waitStatus(manager, bgId, "failed");
    const notifications = manager.collect();
    expect(notifications[0]).toContain("<status>failed</status>");
  });
  it("timeout marks the task failed instead of leaving it running", async () => {
    const workdir = makeSlowWorkdir();
    try {
      const manager = new BackgroundManager(workdir, 1);
      const taskId = manager.start("node slow.js");
      await waitStatus(manager, taskId, "failed", 3000);
      const notifications = manager.collect();
      expect(notifications[0]).toContain("command timed out after 1s");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 5000);

  it("stopAll cancels running commands and leaves a collectable notification", async () => {
    const workdir = makeSlowWorkdir();
    try {
      const manager = new BackgroundManager(workdir);
      const taskId = manager.start("node slow.js");
      await manager.stopAll();
      expect(manager.tasks[taskId]?.status).toBe("cancelled");
      const notifications = manager.collect();
      expect(notifications[0]).toContain("<status>cancelled</status>");
      expect(notifications[0]).toContain("command cancelled");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 15000);
  it("truncates huge background output", async () => {
    const manager = new BackgroundManager(process.cwd(), 120, 100);
    const taskId = manager.start("node -p String.fromCharCode(120).repeat(500)");
    await waitStatus(manager, taskId, "completed");
    const notifications = manager.collect();
    expect(notifications[0]).toContain("... [truncated, 501 chars total]");
  });

  it("collect is one-shot", async () => {
    const manager = makeManager();
    const bgId = manager.start("echo once");
    await waitStatus(manager, bgId, "completed");
    expect(manager.collect()).toHaveLength(1);
    expect(manager.collect()).toEqual([]);
  });
});
