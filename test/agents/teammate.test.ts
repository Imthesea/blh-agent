import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BusMessage } from "../../src/agents/bus.js";
import { TeammateRuntime } from "../../src/agents/teammate.js";
import type { TeammateTeam } from "../../src/agents/teammate.js";
import { HookBus } from "../../src/runtime/hooks.js";
import type { ChatMessage, ChatProvider, Config, ToolDefinition } from "../../src/contracts/types.js";
import { Tracer } from "../../src/tracing/tracer.js";
import type { Task } from "../../src/planning/tasks.js";
import { TaskStore } from "../../src/planning/tasks.js";
import { MockProvider, makeTextMessage, makeToolCallMessage } from "../integration/helpers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teammate-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

class FakeTeam implements TeammateTeam {
  sent: Array<[string, string, string, string]> = [];
  gate = "not_required";
  cwd = "/fake";

  assignmentCwd(_owner: string): string {
    return this.cwd;
  }
  claimTask(_owner: string, taskId: string): string {
    return `Claimed ${taskId}.`;
  }
  completeTask(_owner: string, taskId: string): string {
    return `Completed ${taskId}.`;
  }
  listTasks(): Task[] {
    return [];
  }
  sendMessage(fromName: string, to: string, content: string, msgType = "message"): string {
    this.sent.push([fromName, to, content, msgType]);
    return `Sent to ${to}`;
  }
  submitPlan(_fromName: string, _plan: string): string {
    return "Plan submitted (req_000001).";
  }
  applyShutdownRequest(_name: string, _msg: BusMessage): [boolean, string] {
    return [true, "req_000001"];
  }
  applyPlanResponse(_name: string, _msg: BusMessage): [boolean, string] {
    return [true, "[Plan approved] ok"];
  }
  getPlanGate(_name: string): string {
    return this.gate;
  }
  setActive(_name: string, _status: string): void {}
  releaseCompleted(_name: string): void {}
  finishTeammate(_name: string): void {}
  claimNextTask(_name: string): Task | null {
    return null;
  }
  readInbox(_name: string): BusMessage[] {
    return [];
  }
  async waitForMessages(_name: string, _timeoutMs?: number): Promise<BusMessage[]> {
    return [];
  }
}

function makeTeammate(
  team: TeammateTeam,
  source: ChatProvider | ChatMessage[],
  tracer?: Tracer,
): TeammateRuntime {
  const config: Config = {
    apiKey: "k",
    model: "m",
    workdir: tmpDir,
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
  return new TeammateRuntime(
    "bob",
    "worker",
    "do it",
    null,
    false,
    Array.isArray(source) ? new MockProvider(source) : source,
    config,
    new HookBus(),
    new TaskStore(path.join(tmpDir, ".tasks")),
    team,
    tracer,
  );
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("TeammateRuntime", () => {
  it("work returns idle and sends result", async () => {
    const team = new FakeTeam();
    const runtime = makeTeammate(team, [makeTextMessage("all done")]);
    expect(await runtime.work()).toBe("idle");
    const types = team.sent.map((entry) => entry[3]);
    expect(types).toContain("result");
    expect(types).toContain("idle_notification");
  });

  it("uses response-scoped usage and traces it under the teammate sid", async () => {
    class UsageProvider implements ChatProvider {
      async chat(): Promise<ChatMessage> {
        throw new Error("chat should not be used");
      }

      async chatWithUsage(): Promise<{
        message: ChatMessage;
        usage: { promptTokens: number; completionTokens: number } | null;
      }> {
        return {
          message: makeTextMessage("all done"),
          usage: { promptTokens: 13, completionTokens: 5 },
        };
      }

      lastUsage(): { promptTokens: number; completionTokens: number } {
        return { promptTokens: 999, completionTokens: 999 };
      }
    }

    const team = new FakeTeam();
    const tracer = new Tracer(tmpDir);
    const runtime = new TeammateRuntime(
      "bob",
      "worker",
      "do it",
      null,
      false,
      new UsageProvider(),
      {
        apiKey: "k",
        model: "m",
        workdir: tmpDir,
        bashTimeout: 120,
        maxOutputChars: 30000,
      },
      new HookBus(),
      new TaskStore(path.join(tmpDir, ".tasks")),
      team,
      tracer,
    );

    await expect(runtime.work()).resolves.toBe("idle");

    const traceFiles = readdirSync(path.join(tmpDir, ".blh", "traces"))
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.join(tmpDir, ".blh", "traces", file));
    const events = traceFiles.flatMap((file) => readJsonl(file));

    expect(events.map((event) => event["type"])).toEqual([
      "turn_start",
      "llm",
      "turn_end",
    ]);
    expect(events.every((event) => event["sid"] === "cli:teammate:bob")).toBe(true);
    const llmEvents = events.filter((event) => event["type"] === "llm");
    expect(llmEvents).toEqual([
      expect.objectContaining({ sid: "cli:teammate:bob", usage: { promptTokens: 13, completionTokens: 5 } }),
    ]);
  });

  it("returns stop when the model call is aborted", async () => {
    class AbortableProvider implements ChatProvider {
      async chat(
        _messages: ChatMessage[],
        _tools: ToolDefinition[],
        _maxTokens?: number,
        signal?: AbortSignal,
      ): Promise<ChatMessage> {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("cancelled"), { name: "AbortError" }),
              ),
            { once: true },
          );
        });
      }
    }

    const team = new FakeTeam();
    const runtime = makeTeammate(team, new AbortableProvider());
    const controller = new AbortController();
    const working = runtime.work(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(working).resolves.toBe("stop");
    expect(team.sent).toEqual([]);
  });

  it("sends the original model error to lead and stops", async () => {
    class FailingProvider implements ChatProvider {
      async chat(): Promise<ChatMessage> {
        throw new Error("boom");
      }
    }

    const team = new FakeTeam();
    const runtime = makeTeammate(team, new FailingProvider());

    await expect(runtime.work()).resolves.toBe("stop");
    expect(team.sent).toContainEqual(["bob", "lead", "Error: boom", "error"]);
  });

  it("workspace tools require task", async () => {
    class NoTaskTeam extends FakeTeam {
      assignmentCwd(_owner: string): string {
        throw new Error("Claim a Task before using workspace tools.");
      }
    }
    const runtime = makeTeammate(new NoTaskTeam(), []);
    const result = await runtime.tools.dispatch("write_file", { path: "x.txt", content: "y" });
    expect(result).toContain("Claim a Task");
  });

  it("handleInbox returns true on shutdown and sends a response", () => {
    const team = new FakeTeam();
    const runtime = makeTeammate(team, []);
    const msg: BusMessage = {
      from: "lead",
      to: "bob",
      content: "stop",
      type: "shutdown_request",
      ts: 0,
      metadata: { request_id: "req_000001" },
    };
    expect(runtime.handleInbox([msg])).toBe(true);
    expect(team.sent.some((entry) => entry[3] === "shutdown_response")).toBe(true);
  });

  it("plan gate blocks write", async () => {
    const team = new FakeTeam();
    team.gate = "required";
    const runtime = makeTeammate(team, [
      makeToolCallMessage("write_file", { path: "x.txt", content: "y" }, "c1"),
      makeTextMessage("done"),
    ]);
    expect(await runtime.work()).toBe("continue");
    expect(existsSync(path.join(tmpDir, "x.txt"))).toBe(false);
  });

  it("plan gate keeps teammate working when model replies without a plan", async () => {
    const team = new FakeTeam();
    team.gate = "required";
    const runtime = makeTeammate(team, [makeTextMessage("I will do it.")]);

    expect(await runtime.work()).toBe("continue");
    expect(team.sent.some((entry) => entry[3] === "result")).toBe(false);
    expect(team.sent.some((entry) => entry[3] === "idle_notification")).toBe(false);
    expect(runtime.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("[Plan required]"),
    });
  });
});
