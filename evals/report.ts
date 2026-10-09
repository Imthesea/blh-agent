import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaseOutcome, LiftResult } from "./lift.js";
import { computeLift } from "./lift.js";

export interface RunMetrics {
  toolCalls?: number;
  totalMs?: number;
}

export interface CaseReport {
  caseId: string;
  passed: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  metrics?: RunMetrics;
  judgeScore?: number;
}

export interface AblationSection {
  outcomes: CaseOutcome[];
  controlLabel?: string;
  treatmentLabel?: string;
}

export interface ReportInput {
  cases: CaseReport[];
  ablation?: AblationSection;
}

interface MetricTotals {
  toolCalls: number | null;
  totalMs: number | null;
}

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number | null;
  metrics: MetricTotals;
}

/** 累加各用例某项遥测指标；一个都没有则返回 null（缺失遥测保持不可用，而非当 0）。 */
function sumMetric(
  cases: readonly CaseReport[],
  pick: (metrics: RunMetrics) => number | undefined,
): number | null {
  let total = 0;
  let available = 0;
  for (const item of cases) {
    const value = item.metrics === undefined ? undefined : pick(item.metrics);
    if (value !== undefined) {
      available += 1;
      total += value;
    }
  }
  // 一个都没有则不报，而不是当 0（对齐 pi：缺失遥测保持不可用）
  return available === 0 ? null : total;
}

/** 汇总一组跑分结果：总数、通过/失败数、通过率与遥测合计。 */
export function summarize(cases: readonly CaseReport[]): ReportSummary {
  const total = cases.length;
  const passed = cases.filter((item) => item.passed).length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    passRate: total === 0 ? null : passed / total,
    metrics: {
      toolCalls: sumMetric(cases, (m) => m.toolCalls),
      totalMs: sumMetric(cases, (m) => m.totalMs),
    },
  };
}

/** 把可用遥测指标渲染成 "toolCalls=... time=...s" 片段列表。 */
function renderMetrics(metrics: MetricTotals): string[] {
  const parts: string[] = [];
  if (metrics.toolCalls !== null) parts.push(`toolCalls=${metrics.toolCalls}`);
  if (metrics.totalMs !== null) parts.push(`time=${(metrics.totalMs / 1000).toFixed(2)}s`);
  return parts;
}

/** 把单次跑分 + 可选 A/B 对比渲染成 markdown。纯函数，无 I/O。 */
export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  const summary = summarize(input.cases);

  lines.push("# Eval report");
  if (summary.total === 0) {
    lines.push("No cases.");
  } else {
    const pct = ((summary.passRate ?? 0) * 100).toFixed(1);
    lines.push(`Pass: ${summary.passed}/${summary.total} (${pct}%)`);
  }

  const metricParts = renderMetrics(summary.metrics);
  if (metricParts.length > 0) lines.push(`Metrics: ${metricParts.join(", ")}`);

  const judgeScores = input.cases
    .map((item) => item.judgeScore)
    .filter((score): score is number => score !== undefined);
  if (judgeScores.length > 0) {
    const avg = judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length;
    lines.push(`Judge avg: ${avg.toFixed(2)} (${judgeScores.length} cases)`);
  }

  const failedCases = input.cases.filter((item) => !item.passed);
  if (failedCases.length > 0) {
    lines.push("");
    lines.push("## Failed cases");
    for (const item of failedCases) {
      lines.push(`- ${item.caseId}`);
      for (const check of item.checks.filter((c) => !c.pass)) {
        lines.push(`    - ${check.name}: ${check.detail}`);
      }
    }
  }

  if (input.ablation !== undefined) {
    lines.push("");
    lines.push("## A/B comparison");
    const result: LiftResult = computeLift(input.ablation.outcomes);
    const control = input.ablation.controlLabel ?? "control";
    const treatment = input.ablation.treatmentLabel ?? "treatment";
    if (result.lift === null) {
      lines.push(`Blocked: ${result.blockedPairs} pair(s) missing a score; lift withheld.`);
    } else {
      const cp = ((result.controlPassRate ?? 0) * 100).toFixed(1);
      const tp = ((result.treatmentPassRate ?? 0) * 100).toFixed(1);
      const sign = result.lift >= 0 ? "+" : "";
      lines.push(`${control}: ${cp}% → ${treatment}: ${tp}% (lift ${sign}${result.lift.toFixed(4)})`);
    }
    if (result.flags.length > 0) lines.push(`Flags: ${result.flags.join(", ")}`);
  }

  return lines.join("\n") + "\n";
}

/** 把报告写到 <dir>/<filename>，返回落盘路径。 */
export async function writeReport(dir: string, content: string, filename = "report.md"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content, "utf8");
  return filePath;
}