import type { Harness } from "../src/runtime/harness.js";
import { checkCase, type CaseContext, type CheckResult, type EvalCase } from "./check.js";
import { collectContext } from "./collect.js";
import { judgeCase, type JudgeOptions, type JudgeResult } from "./judge.js";

export interface RunCaseOptions {
  /** 是否顺带跑 LLM judge（DeepEval，需要 DEEPSEEK_API_KEY）。默认 false。 */
  judge?: boolean;
  judgeOptions?: JudgeOptions;
}

export interface RunCaseResult {
  evalCase: EvalCase;
  context: CaseContext;
  result: CheckResult;
  judge?: JudgeResult;
}

/**
 * 统一跑一个用例：turn → 收集上下文 → 确定性打分 →（可选）LLM judge。
 * harness 生命周期由调用方管理；workdir 从 harness.config.workdir 读取，避免传错。
 */
export async function runCase(
  harness: Harness,
  evalCase: EvalCase,
  options: RunCaseOptions = {},
): Promise<RunCaseResult> {
  let context: CaseContext;
  try {
    const transcript = harness.newTranscript();
    await harness.runTurn(transcript, evalCase.input);
    context = await collectContext(transcript, harness.config.workdir, evalCase);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      evalCase,
      context: {
        toolCalls: [],
        tasksCompleted: 0,
        files: new Map(),
        finalOutput: "",
        safetyViolations: [],
      },
      result: {
        passed: false,
        checks: [{ name: "run", pass: false, detail: `跑分失败: ${message}` }],
      },
    };
  }
  const result = checkCase(evalCase, context);
  const judge =
    options.judge === true ? await judgeCase(evalCase, context, options.judgeOptions) : undefined;
  return {
    evalCase,
    context,
    result,
    ...(judge !== undefined ? { judge } : {}),
  };
}