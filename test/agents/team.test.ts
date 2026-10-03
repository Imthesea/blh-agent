import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../src/agents/bus.js";
import { TeamRuntime } from "../../src/agents/team.js";
import { HookBus } from "../../src/core/hooks.js";
import type { Config } from "../../src/core/types.js";
import { AgentLock } from "../../src/core/agent-lock.js";
import { TaskStore } from "../../src/planning/tasks.js";
import { MockProvider } from "../integration/helpers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "team-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTeam(): TeamRuntime {
  const config: Config = {
    apiKey: "k",
    model: "m",
    workdir: tmpDir,
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
  return new TeamRuntime(
    new TaskStore(path.join(tmpDir, ".tasks")),
    new MessageBus(path.join(tmpDir, ".mailboxes")),
    new AgentLock(),
    tmpDir,
    path.join(tmpDir, ".worktrees"),
    new MockProvider([]),
    config,
    new HookBus(),
  );
}

describe("TeamRuntime", () => {
  it("claim_task assigns cwd", () => {
    const team = makeTeam();
    const task = team.store.create("ship");
    expect(team.claimTask("alice", task.id)).toBe(`Claimed ${task.id}.`);
    expect(team.assignments.get("alice")?.taskId).toBe(task.id);
    expect(team.store.load(task.id).owner).toBe("alice");
  });

  it("claim_task rejects second assignment", () => {
    const team = makeTeam();
    const a = team.store.create("a");
    const b = team.store.create("b");
    team.claimTask("alice", a.id);
    expect(team.claimTask("alice", b.id)).toContain("complete its current task first");
  });

  it("claim_next_task is atomic", () => {
    const team = makeTeam();
    const task = team.store.create("only");
    const claimed: Array<string | null> = [];
    for (const name of ["alice", "bob"]) {
      const next = team.claimNextTask(name);
      claimed.push(next ? next.id : null);
    }
    expect(claimed.filter((id) => id !== null)).toEqual([task.id]);
  });

  it("consume_and_inject_team appends team events", () => {
    const team = makeTeam();
    team.bus.send("bob", "lead", "auth done", "result");
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(team.consumeAndInjectTeam(messages)).toBe(1);
    const last = messages[messages.length - 1];
    expect(last?.content).toContain("auth done");
    expect(last?.content?.startsWith("[Team events]")).toBe(true);
  });

  it("request_shutdown_protocol", () => {
    const team = makeTeam();
    team.activeTeammates.set("bob", "working");
    expect(team.requestShutdown("bob")).toContain("Shutdown requested");
    expect([...team.pendingRequests.values()].some((state) => state.type === "shutdown")).toBe(true);
    expect(team.bus.readInbox("bob")[0]?.type).toBe("shutdown_request");
  });
  it("accepted shutdown requests are removed from pending state", () => {
    const team = makeTeam();
    team.activeTeammates.set("bob", "working");
    team.requestShutdown("bob");
    const message = team.bus.readInbox("bob")[0]!;
    const requestId = String(message.metadata["request_id"]);
    expect(team.applyShutdownRequest("bob", message)).toEqual([true, requestId]);
    expect(team.pendingRequests.has(requestId)).toBe(false);
  });

  it("review_plan_protocol", () => {
    const team = makeTeam();
    team.activeTeammates.set("bob", "working");
    team.planGates.set("bob", "required");
    expect(team.submitPlan("bob", "do auth first")).toContain("Plan submitted");
    const requestId = [...team.pendingRequests.keys()][0] as string;
    expect(team.reviewPlan(requestId, true)).toContain("Plan approved");
    expect(team.pendingRequests.get(requestId)?.status).toBe("approved");
  });
  it("applied plan responses and teammate cleanup remove pending requests", () => {
    const team = makeTeam();
    team.activeTeammates.set("bob", "working");
    team.planGates.set("bob", "required");
    team.submitPlan("bob", "do auth first");
    const requestId = [...team.pendingRequests.keys()][0]!;
    team.reviewPlan(requestId, true);
    const response = team.bus.readInbox("bob")[0]!;
    expect(team.applyPlanResponse("bob", response)[0]).toBe(true);
    expect(team.pendingRequests.has(requestId)).toBe(false);

    team.requestShutdown("bob");
    const shutdownId = [...team.pendingRequests.keys()][0]!;
    team.finishTeammate("bob");
    expect(team.pendingRequests.has(shutdownId)).toBe(false);
  });

  it("leadTick catches teamTurn errors and releases lock", async () => {
    const team = makeTeam();
    const releaseSpy = vi.spyOn(team.agentLock, "release");
    team.bus.send("bob", "lead", "hi");
    team.setTeamTurn(async () => {
      throw new Error("boom");
    });
    await (team as unknown as { leadTick: () => Promise<void> }).leadTick();
    expect(releaseSpy).toHaveBeenCalled();
    releaseSpy.mockRestore();
  });
});
