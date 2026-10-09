import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderReport, summarize, writeReport, type CaseReport } from "../../evals/report.js";

describe("summarize", () => {
  it("统计通过率与指标求和，缺失指标不计为 0", () => {
    const cases: CaseReport[] = [
      { caseId: "a", passed: true, checks: [], metrics: { toolCalls: 2, totalMs: 100 } },
      { caseId: "b", passed: false, checks: [], metrics: { toolCalls: 3 } },
    ];
    const s = summarize(cases);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.passRate).toBe(0.5);
    expect(s.metrics.toolCalls).toBe(5);
    expect(s.metrics.totalMs).toBe(100); // 只有一个用例报了 totalMs，但也求和
  });

  it("全部缺失的指标为 null", () => {
    const s = summarize([{ caseId: "a", passed: true, checks: [] }]);
    expect(s.metrics.toolCalls).toBeNull();
    expect(s.metrics.totalMs).toBeNull();
  });

  it("空列表 passRate 为 null", () => {
    const s = summarize([]);
    expect(s.passRate).toBeNull();
  });
});

describe("renderReport", () => {
  it("包含通过率、失败用例 detail、指标", () => {
    const cases: CaseReport[] = [
      {
        caseId: "fail-case",
        passed: false,
        checks: [{ name: "expect_files:x.txt", pass: false, detail: "x.txt 未落地" }],
        metrics: { toolCalls: 100 },
      },
      { caseId: "ok-case", passed: true, checks: [], metrics: { toolCalls: 50 } },
    ];
    const text = renderReport({ cases });
    expect(text).toContain("Pass: 1/2 (50.0%)");
    expect(text).toContain("fail-case");
    expect(text).toContain("expect_files:x.txt: x.txt 未落地");
    expect(text).toContain("toolCalls=150");
  });

  it("渲染 A/B lift 与 flags", () => {
    const text = renderReport({
      cases: [],
      ablation: {
        controlLabel: "without_memory",
        treatmentLabel: "with_memory",
        outcomes: [
          { caseId: "a", arm: "control", runNumber: 1, outcome: "failed" },
          { caseId: "a", arm: "treatment", runNumber: 1, outcome: "passed" },
        ],
      },
    });
    expect(text).toContain("without_memory: 0.0% → with_memory: 100.0% (lift +1.0000)");
    expect(text).toContain("treatment-saturated");
  });

  it("渲染 judge 平均分", () => {
    const text = renderReport({
      cases: [
        { caseId: "a", passed: true, checks: [], judgeScore: 0.8 },
        { caseId: "b", passed: true, checks: [], judgeScore: 0.6 },
      ],
    });
    expect(text).toContain("Judge avg: 0.70 (2 cases)");
  });

  it("blocked pair 时 lift withhold", () => {
    const text = renderReport({
      cases: [],
      ablation: {
        outcomes: [
          { caseId: "a", arm: "control", runNumber: 1, outcome: "passed" },
          { caseId: "a", arm: "treatment", runNumber: 1, outcome: "errored" },
        ],
      },
    });
    expect(text).toContain("lift withheld");
    expect(text).toContain("Blocked: 1");
  });
});

describe("writeReport", () => {
  let tmpDir = "";
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-report-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("把内容写到 .eval 风格目录并返回路径", async () => {
    const filePath = await writeReport(tmpDir, "# hi\n");
    expect(filePath).toBe(path.join(tmpDir, "report.md"));
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("# hi\n");
  });
});