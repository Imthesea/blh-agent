import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config/config.js";
import { createProvider } from "../src/providers/registry.js";
import { hasJudgeKey } from "./judge.js";
import { loadCases } from "./load-cases.js";
import { runCase } from "./runner.js";
import { createSandboxHarness, caseNeedsFullTools } from "./sandbox.js";
import { renderReport, writeReport, type CaseReport } from "./report.js";

/** 入口：解析 CLI 参数、逐用例跑分、渲染并落盘报告。 */
async function main(): Promise<void> {
  // 解析命令行参数，定义各选项的类型与默认值
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      file: { type: "string", default: "evals/cases.jsonl" },
      workdir: { type: "string" },
      judge: { type: "boolean", default: false },
      "judge-model": { type: "string" },
      "full-tools": { type: "boolean", default: false },
      output: { type: "string", default: ".eval" },
    },
  });

  // 要跑 LLM judge 必须先有裁判模型密钥
  if (values.judge === true && !hasJudgeKey()) {
    throw new Error("--judge 需要环境变量 DEEPSEEK_API_KEY");
  }

  // 读题库、准备 workdir：未指定则建临时目录，结束后需要清理
  const file = values.file ?? "evals/cases.jsonl";
  const cases = loadCases(file);
  const workdir = values.workdir ?? mkdtempSync(path.join(os.tmpdir(), "blh-live-"));
  const cleanupTemp = values.workdir === undefined;
  // 默认 safe 策略；加 --full-tools 才放开 bash 等工具（失去沙箱保护）
  const policy = values["full-tools"] === true ? "full" : "safe";

  try {
    // 加载配置、创建 provider 与最小沙箱 harness
    const config = loadConfig({ configRoot: process.cwd(), workdir });
    const provider = createProvider(config);
    const harness = createSandboxHarness(config, provider, { policy });

    // safe 策略下提前警告：哪些用例因需要被禁工具而注定不通过
    if (policy === "safe") {
      const needing = cases.filter((item) => caseNeedsFullTools(item)).map((item) => item.id);
      if (needing.length > 0) {
        console.warn(
          `[warn] 以下用例需要 bash，safe 沙箱下不会通过：${needing.join(", ")}（加 --full-tools 可放开，但失去沙箱保护）`,
        );
      }
    }

    // 逐用例跑分，收集每个用例的通过情况、check 明细、耗时与（可选）judge 分数
    const caseReports: CaseReport[] = [];
    for (const evalCase of cases) {
      const started = Date.now();
      const { result, context, judge } = await runCase(harness, evalCase, {
        judge: values.judge === true,
        ...(values["judge-model"] !== undefined
          ? { judgeOptions: { judgeModel: values["judge-model"] } }
          : {}),
      });
      const elapsed = Date.now() - started;
      caseReports.push({
        caseId: evalCase.id,
        passed: result.passed,
        checks: result.checks,
        metrics: { toolCalls: context.toolCalls.length, totalMs: elapsed },
        ...(judge !== undefined ? { judgeScore: judge.score } : {}),
      });
      // 拼一条 PASS/FAIL 摘要：附失败项名称与 judge 分数
      const failed = result.checks.filter((check) => !check.pass).map((check) => check.name);
      const failNote = failed.length > 0 ? ` [${failed.join(", ")}]` : "";
      const judgePart = judge !== undefined ? ` judge=${judge.score.toFixed(2)}` : "";
      console.log(`${result.passed ? "PASS" : "FAIL"} ${evalCase.id}${failNote}${judgePart}`);
    }

    // 释放 harness 资源
    await harness.dispose();

    // 渲染报告、落盘并打印
    const report = renderReport({ cases: caseReports });
    const outputDir = path.resolve(values.output ?? ".eval");
    const reportPath = await writeReport(outputDir, report);
    console.log("");
    console.log(report);
    console.log(`Report: ${reportPath}`);
  } finally {
    // 用完清理临时 workdir（用户显式指定 workdir 时不删）
    if (cleanupTemp) {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});