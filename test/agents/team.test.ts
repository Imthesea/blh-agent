import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../src/agents/bus.js";
import { TeamRuntime } from "../../src/agents/team.js";
import { HookBus } from "../../src/runtime/hooks.js";
import type { Config } from "../../src/contracts/types.js";
import type { ChatProvider, ChatMessage, ToolDefinition } from "../../src/contracts/types.js";
import { AgentLock } from "../../src/runtime/agent-lock.js";
import { TaskStore } from "../../src/planning/tasks.js";
import { MockProvider } from "../integration/helpers.js";
import { Transcript } from "../../src/session/transcript.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "team-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

class AbortableProvider implements ChatProvider {
  aborted = false;

  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _maxTokens?: number,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    if (signal === undefined) throw new Error("expected an abort signal");
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  }
}

function makeTeam(provider: ChatProvider = new MockProvider([])): TeamRuntime {
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
    provider,
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
    const transcript = new Transcript();
    transcript.append({ role: "user", content: "hi" });
    expect(team.consumeAndInjectTeam(transcript)).toBe(1);
    const last = transcript.messages.at(-1);
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

  it("stop is restartable and still allows spawning", async () => {
    const team = makeTeam();
    team.activeTeammates.set("bob", "working");
    team.start();

    team.stop();

    expect(team.started).toBe(false);
    expect([...team.pendingRequests.values()].some((state) => state.type === "shutdown")).toBe(
      true,
    );

    team.start();
    expect(team.started).toBe(true);
    expect(team.spawnTeammate("alice", "worker", "do work")).toContain("spawned as worker");

    await team.dispose();
  });

  it("dispose cancels and waits for teammate runs", async () => {
    const provider = new AbortableProvider();
    const team = makeTeam(provider);
    team.spawnTeammate("bob", "worker", "do work");
    expect(team.activeTeammates.has("bob")).toBe(true);

    await team.dispose();

    expect(provider.aborted).toBe(true);
    expect(team.activeTeammates.has("bob")).toBe(false);
    expect(team.spawnTeammate("alice", "worker", "more work")).toContain(
      "team is shutting down",
    );
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

  it("dispose aborts and waits for the active lead turn", async () => {
    const team = makeTeam();
    let seenSignal: AbortSignal | undefined;
    team.bus.send("bob", "lead", "hi");
    team.setTeamTurn(async (signal) => {
      seenSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const leadTick = (
      team as unknown as { leadTick: () => Promise<void> }
    ).leadTick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const dispose = team.dispose();

    expect(seenSignal?.aborted).toBe(true);
    await leadTick;
    await dispose;
    expect(team.agentLock.tryAcquire()).toBe(true);
    team.agentLock.release();
  });
});
