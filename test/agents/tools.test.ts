import { describe, expect, it } from "vitest";
import { registerAgentTools } from "../../src/agents/tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";

class FakeSubagent {
  calls: string[] = [];
  signals: Array<AbortSignal | undefined> = [];
  async run(prompt: string, signal?: AbortSignal): Promise<string> {
    this.calls.push(prompt);
    this.signals.push(signal);
    return "sub-result";
  }
}

class FakeTeam {
  spawnTeammate(
    name: string,
    _role: string,
    _prompt: string,
    _taskId?: string,
    _requirePlan?: boolean,
  ): string {
    return `spawned ${name}`;
  }
  listTeammates(): string {
    return "no teammates";
  }
  leadSendMessage(to: string, _content: string): string {
    return `sent ${to}`;
  }
  requestShutdown(teammate: string): string {
    return `shutdown ${teammate}`;
  }
  requestPlan(teammate: string, _task: string): string {
    return `plan ${teammate}`;
  }
  reviewPlan(requestId: string, _approve: boolean, _feedback?: string): string {
    return `reviewed ${requestId}`;
  }
  createWorktree(name: string, _taskId: string): string {
    return `wt ${name}`;
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAgentTools(registry, new FakeSubagent(), new FakeTeam());
  return registry;
}

describe("registerAgentTools", () => {
  it("registers agent tools", () => {
    const names = new Set(makeRegistry().list().map((tool) => tool.name));
    expect(names).toEqual(
      new Set([
        "task",
        "spawn_teammate",
        "list_teammates",
        "send_message",
        "request_shutdown",
        "request_plan",
        "review_plan",
        "create_worktree",
      ]),
    );
  });

  it("task dispatches to subagent", async () => {
    const sub = new FakeSubagent();
    const registry = new ToolRegistry();
    registerAgentTools(registry, sub, new FakeTeam());
    expect(await registry.dispatch("task", { prompt: "explore" })).toBe("sub-result");
    expect(sub.calls).toEqual(["explore"]);
  });
  it("task passes the dispatch AbortSignal", async () => {
    const sub = new FakeSubagent();
    const registry = new ToolRegistry();
    registerAgentTools(registry, sub, new FakeTeam());
    const controller = new AbortController();
    await registry.dispatch("task", { prompt: "explore" }, controller.signal);
    expect(sub.signals).toEqual([controller.signal]);
  });

  it("spawn_teammate dispatches", async () => {
    const result = await makeRegistry().dispatch("spawn_teammate", {
      name: "bob",
      role: "worker",
      prompt: "go",
    });
    expect(result).toBe("spawned bob");
  });
});
