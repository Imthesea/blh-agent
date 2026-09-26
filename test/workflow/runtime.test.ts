import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowJournal } from "../../src/workflow/journal.js";
import {
  Budget,
  ExecutionState,
  MockWorkflowRunner,
  type WorkflowTaskLike,
} from "../../src/workflow/runtime.js";
import { WorkflowInputError, type JsonSchema } from "../../src/workflow/schema.js";
import type { ChatProvider } from "../../src/core/types.js";

function makeTask(): WorkflowTaskLike {
  return {
    usage: { agents: 0, tokens: 0 },
    progressEvent(): void {},
  };
}

describe("ExecutionState", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "wf-runtime-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeState(task = makeTask(), budget = new Budget()) {
    const journal = new WorkflowJournal("wf_x_0000000000000001", false, tmpDir);
    return { state: new ExecutionState(task, journal, new MockWorkflowRunner(), budget, {}), task };
  }

  it("agent returns value", async () => {
    const { state, task } = makeState();
    const value = await state.agent("hello prompt");
    expect(typeof value).toBe("string");
    expect(task.usage.agents).toBe(1);
    expect(task.usage.tokens).toBeGreaterThan(0);
  });

  it("agent schema validates", async () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["isReal", "reason"],
      properties: { isReal: { type: "boolean" }, reason: { type: "string" } },
    };
    const { state } = makeState();
    const value = await state.agent("verify", schema, "verify:1");
    expect(value).toEqual({ isReal: true, reason: "reproduced" });
  });

  it("parallel barrier", async () => {
    const { state } = makeState();
    const order: string[] = [];
    const result = await state.parallel([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a");
        return 1;
      },
      async () => {
        order.push("b");
        return 2;
      },
    ]);
    expect(result).toEqual([1, 2]);
    expect(order).toEqual(["b", "a"]);
  });

  it("pipeline order", async () => {
    const { state } = makeState();
    const result = await state.pipeline(
      [1, 2, 3],
      async (value: unknown) => Number(value) * 2,
      async (value: unknown) => Number(value) + 1,
    );
    expect(result).toEqual([3, 5, 7]);
  });

  it("agent resume uses cache", async () => {
    const first = makeState();
    const value = await first.state.agent("cache me");
    expect(first.task.usage.agents).toBe(1);

    const task = makeTask();
    const resumedJournal = new WorkflowJournal("wf_x_0000000000000001", true, tmpDir);
    const state = new ExecutionState(task, resumedJournal, new MockWorkflowRunner(), new Budget(), {});
    const resumed = await state.agent("cache me");
    expect(resumed).toEqual(value);
    expect(task.usage.agents).toBe(0);
  });

  it("budget exceeded", () => {
    const budget = new Budget(5);
    budget.add(3);
    expect(budget.remaining()).toBe(2);
    expect(() => budget.add(3)).toThrow(WorkflowInputError);
  });
});

describe("OpenAIWorkflowRunner", () => {
  it("provider 缺少 chatCompletion 时构造抛错", async () => {
    const { OpenAIWorkflowRunner } = await import("../../src/workflow/runtime.js");
    const provider = {
      chat: async () => ({ role: "assistant" as const, content: null }),
    } as unknown as ChatProvider;
    expect(() => new OpenAIWorkflowRunner(provider)).toThrow(/chatCompletion/);
  });
});
