import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockProvider, makeToolCallMessage, makeTextMessage } from "../integration/helpers.js";
import { createAblationPlan } from "../../evals/plan.js";
import { computeLift, type CaseOutcome } from "../../evals/lift.js";
import { createSandboxHarness } from "../../evals/sandbox.js";
import { runCase } from "../../evals/runner.js";
import type { ChatMessage, Config } from "../../src/contracts/types.js";

describe("createAblationPlan", () => {
  it("奇数次 run control→treatment，偶数次反序", () => {
    const tasks = createAblationPlan(["a", "b"], 2);
    expect(tasks).toEqual([
      { caseId: "a", arm: "control", runNumber: 1 },
      { caseId: "a", arm: "treatment", runNumber: 1 },
      { caseId: "a", arm: "treatment", runNumber: 2 },
      { caseId: "a", arm: "control", runNumber: 2 },
      { caseId: "b", arm: "control", runNumber: 1 },
      { caseId: "b", arm: "treatment", runNumber: 1 },
      { caseId: "b", arm: "treatment", runNumber: 2 },
      { caseId: "b", arm: "control", runNumber: 2 },
    ]);
  });

  it("runsPerVariant 非法时报错", () => {
    expect(() => createAblationPlan(["a"], 0)).toThrow();
    expect(() => createAblationPlan(["a"], 1.5)).toThrow();
  });
});

describe("computeLift", () => {
  it("control 全挂、treatment 全过 → lift=1 + treatment-saturated", () => {
    const outcomes: CaseOutcome[] = [
      { caseId: "a", arm: "control", runNumber: 1, outcome: "failed" },
      { caseId: "a", arm: "treatment", runNumber: 1, outcome: "passed" },
    ];
    const r = computeLift(outcomes);
    expect(r.lift).toBe(1);
    expect(r.controlPassRate).toBe(0);
    expect(r.treatmentPassRate).toBe(1);
    expect(r.flags).toContain("treatment-saturated");
  });

  it("两臂同分 → no-lift + 双侧 saturated", () => {
    const outcomes: CaseOutcome[] = [
      { caseId: "a", arm: "control", runNumber: 1, outcome: "passed" },
      { caseId: "a", arm: "treatment", runNumber: 1, outcome: "passed" },
    ];
    const r = computeLift(outcomes);
    expect(r.lift).toBe(0);
    expect(r.flags).toContain("no-lift");
    expect(r.flags).toContain("control-saturated");
    expect(r.flags).toContain("treatment-saturated");
  });

  it("treatment 更差 → negative-delta", () => {
    const outcomes: CaseOutcome[] = [
      { caseId: "a", arm: "control", runNumber: 1, outcome: "passed" },
      { caseId: "a", arm: "treatment", runNumber: 1, outcome: "failed" },
    ];
    const r = computeLift(outcomes);
    expect(r.lift).toBe(-1);
    expect(r.flags).toContain("negative-delta");
  });

  it("任一臂 errored → blocked，headline withhold", () => {
    const outcomes: CaseOutcome[] = [
      { caseId: "a", arm: "control", runNumber: 1, outcome: "passed" },
      { caseId: "a", arm: "treatment", runNumber: 1, outcome: "errored" },
    ];
    const r = computeLift(outcomes);
    expect(r.blockedPairs).toBe(1);
    expect(r.eligiblePairs).toBe(0);
    expect(r.lift).toBeNull();
    expect(r.controlPassRate).toBeNull();
  });

  it("同一 (case, arm) 跨 run 结果不一致 → flaky", () => {
    const outcomes: CaseOutcome[] = [
      { caseId: "a", arm: "control", runNumber: 1, outcome: "passed" },
      { caseId: "a", arm: "control", runNumber: 2, outcome: "failed" },
      { caseId: "a", arm: "treatment", runNumber: 1, outcome: "passed" },
      { caseId: "a", arm: "treatment", runNumber: 2, outcome: "passed" },
    ];
    const r = computeLift(outcomes);
    expect(r.flags).toContain("flaky");
  });
});

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-ablation-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("A/B ablation 端到端演示", () => {
  it("去掉 write_file 工具导致通过率从 1 掉到 0", async () => {
    const evalCase = {
      id: "write-hello",
      input: "创建 hello.txt 写入 world",
      expect_files: [{ path: "hello.txt", contains: "world" }],
    };
    const script: ChatMessage[] = [
      makeToolCallMessage("write_file", { path: "hello.txt", content: "world" }, "c1"),
      makeTextMessage("done"),
    ];

    const outcomes: CaseOutcome[] = [];
    for (const task of createAblationPlan([evalCase.id], 1)) {
      const workdir = path.join(tempDir, task.arm);
      await fs.mkdir(workdir, { recursive: true });
      const config: Config = {
        apiKey: "k",
        model: "m",
        workdir,
        bashTimeout: 120,
        maxOutputChars: 30000,
      };
      const harness = createSandboxHarness(config, new MockProvider([...script]), {
        policy: "full",
        disabledTools: task.arm === "control" ? ["write_file"] : [],
      });
      const { result } = await runCase(harness, evalCase);
      outcomes.push({
        caseId: task.caseId,
        arm: task.arm,
        runNumber: task.runNumber,
        outcome: result.passed ? "passed" : "failed",
      });
    }

    const lift = computeLift(outcomes);
    expect(lift.controlPassRate).toBe(0);
    expect(lift.treatmentPassRate).toBe(1);
    expect(lift.lift).toBe(1);
  });
});