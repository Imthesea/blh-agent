import { describe, it, expect, vi } from "vitest";
import { repl } from "../../src/cli/repl.js";
import type { TurnRunner } from "../../src/cli/repl.js";
import { makeTextMessage, MockProvider } from "../integration/helpers.js";
import type { Config } from "../../src/contracts/types.js";
import { EventBus } from "../../src/runtime/events.js";
import { Harness } from "../../src/runtime/harness.js";
import { HookBus } from "../../src/runtime/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackgroundManager } from "../../src/jobs/background.js";
import { CronScheduler } from "../../src/jobs/cron.js";
import { JobsRuntime } from "../../src/jobs/runtime.js";
import { MessageBus } from "../../src/agents/bus.js";
import { TeamRuntime } from "../../src/agents/team.js";
import { TaskStore } from "../../src/planning/tasks.js";
import { GoalController } from "../../src/goals/controller.js";
import { Transcript } from "../../src/session/transcript.js";

function fakeRunner(replies: string[]): TurnRunner {
  let replyIndex = 0;
  return {
    newTranscript: () => new Transcript(),
    runTurn: vi.fn(async (transcript: Transcript, _text: string) => {
      const reply = replies[replyIndex++] ?? "";
      transcript.append(makeTextMessage(reply));
    }),
  };
}

function goalRunner() {
  const goal = new GoalController({
    evaluate: async () => ({ ok: false, reason: "", impossible: false }),
  });
  const runner: TurnRunner = {
    newTranscript: () => new Transcript(),
    runTurn: vi.fn(async (transcript: Transcript, text: string) => {
      transcript.append(makeTextMessage(`reply:${text}`));
    }),
    goal,
    goalCommand: Harness.prototype.goalCommand,
  };
  return { runner, goal };
}

async function runRepl(lines: string[], runner: TurnRunner) {
  const printed: string[] = [];
  const input = (async function* () {
    for (const line of lines) yield line;
  })();
  await repl(runner, {
    readLine: async () => {
      const next = await input.next();
      return next.done ? null : next.value; // null = EOF
    },
    print: (text: string) => {
      printed.push(text);
    },
    write: () => {},
  });
  return printed;
}

describe("repl", () => {
  it("prints banner and replies until exit", async () => {
    const runner = fakeRunner(["answer-1"]);
    const printed = await runRepl(["hello", "exit"], runner);
    expect(printed[0]).toBe("blh — type 'exit' to quit");
    expect(printed).toContain("answer-1");
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
  });

  it("quits on EOF and on quit, skips empty lines", async () => {
    const runner = fakeRunner([]);
    const printed = await runRepl(["", "  ", "quit"], runner);
    expect(runner.runTurn).not.toHaveBeenCalled();
    expect(printed).toHaveLength(1); // 只有 banner
  });

  it("stops on EOF (null)", async () => {
    const runner = fakeRunner(["r"]);
    const printed = await runRepl(["q1"], runner);
    expect(printed).toContain("r");
  });

  it("starts and stops runtime", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "repl-jobs-"));
    try {
      const runner = fakeRunner([]);
      const jobs = new JobsRuntime(
        new BackgroundManager(tmpDir),
        new CronScheduler(path.join(tmpDir, ".scheduled_tasks.json")),
      );
      runner.jobs = jobs;
      runner.runScheduledTurn = async () => {};
      await runRepl(["hello", "exit"], runner);
      expect(jobs.started).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("starts and stops team runtime", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "repl-agents-"));
    try {
      const config: Config = {
        apiKey: "k",
        model: "m",
        workdir: ".",
        bashTimeout: 120,
        maxOutputChars: 30000,
      };
      const jobs = new JobsRuntime(
        new BackgroundManager(tmpDir),
        new CronScheduler(path.join(tmpDir, ".scheduled_tasks.json")),
      );
      const agents = new TeamRuntime(
        new TaskStore(path.join(tmpDir, ".tasks")),
        new MessageBus(path.join(tmpDir, ".mailboxes")),
        jobs.agentLock,
        ".",
        path.join(tmpDir, ".worktrees"),
        new MockProvider([]),
        config,
        new HookBus(),
      );
      const harness = new Harness(
        config,
        new MockProvider([makeTextMessage("done")]),
        new ToolRegistry(),
        new HookBus(),
        undefined,
        undefined,
        undefined,
        jobs,
        agents,
      );
      await runRepl(["hello", "exit"], harness);
      expect(agents.started).toBe(false);
      expect(jobs.started).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("/goal prints status and skips turn", async () => {
    const { runner } = goalRunner();
    const printed = await runRepl(["/goal", "exit"], runner);
    expect(printed).toContain("No goal set");
    expect(runner.runTurn).not.toHaveBeenCalled();
  });

  it("/goal clear prints cleared and skips turn", async () => {
    const { runner, goal } = goalRunner();
    goal.setGoal("finish");
    const printed = await runRepl(["/goal clear", "exit"], runner);
    expect(printed).toContain("Goal cleared: finish");
    expect(runner.runTurn).not.toHaveBeenCalled();
  });

  it("/goal <condition> sets goal and runs turn with condition", async () => {
    const { runner, goal } = goalRunner();
    const printed = await runRepl(["/goal finish the task", "exit"], runner);
    expect(goal.active?.condition).toBe("finish the task");
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(printed).toContain("reply:finish the task");
  });

  it("keeps running after a turn throws", async () => {
    const runner: TurnRunner = {
      newTranscript: () => new Transcript(),
      runTurn: vi.fn(async () => {
        throw new Error("402 Insufficient Balance");
      }),
    };
    const printed = await runRepl(["hello", "exit"], runner);
    expect(printed).toContain("Error: 402 Insufficient Balance");
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
  });

  it("streams text deltas and tool progress without double-printing", async () => {
    const runner: TurnRunner = {
      newTranscript: () => new Transcript(),
      runTurn: vi.fn(async (transcript: Transcript, _text: string, events?: EventBus) => {
        await events?.emit({ type: "turn_start" });
        await events?.emit({ type: "assistant_text_delta", text: "Hel" });
        await events?.emit({ type: "assistant_text_delta", text: "lo" });
        await events?.emit({ type: "tool_call", id: "c1", name: "echo", arguments: "{}" });
        await events?.emit({ type: "tool_result", id: "c1", name: "echo", output: "ok", isError: false });
        await events?.emit({ type: "turn_end" });
        transcript.append(makeTextMessage("Hello"));
      }),
    };
    const printed: string[] = [];
    const writes: string[] = [];
    const input = (async function* () {
      yield "hello";
    })();
    await repl(runner, {
      readLine: async () => {
        const next = await input.next();
        return next.done ? null : next.value;
      },
      print: (text: string) => {
        printed.push(text);
      },
      write: (text: string) => {
        writes.push(text);
      },
    });
    expect(writes.join("")).toBe("Hello\n");
    expect(printed).toContain("[tool] echo {}");
    expect(printed).toContain("[ok] echo");
    expect(printed).not.toContain("Hello");
  });
});
