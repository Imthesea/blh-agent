import { GEval } from "deepeval/metrics";
import { LLMTestCase, SingleTurnParams } from "deepeval/test-case";
import { DeepSeekModel } from "deepeval/models";
import type { CaseContext, EvalCase } from "./check.js";

export interface JudgeOptions {
  judgeModel?: string;
  judgeApiKey?: string;
  judgeBaseUrl?: string;
  threshold?: number;
}

export interface JudgeResult {
  score: number;
  reason: string | undefined;
  success: boolean;
}

/** 是否配置了裁判模型密钥（默认 DeepSeek 的 DEEPSEEK_API_KEY）。 */
export function hasJudgeKey(): boolean {
  const key = process.env.DEEPSEEK_API_KEY;
  return key !== undefined && key !== "";
}

/** 把 blh 的上下文快照压成一段给裁判看的文本。 */
function contextToText(evalCase: EvalCase, context: CaseContext): string {
  const lines: string[] = [`用户指令: ${evalCase.input}`];
  for (const call of context.toolCalls) {
    lines.push(`- 工具调用: ${call.name}(${JSON.stringify(call.args)})`);
  }
  for (const [filePath, content] of context.files) {
    lines.push(`- 产物文件 ${filePath}: ${content.slice(0, 200)}`);
  }
  if (context.safetyViolations.length > 0) {
    lines.push(`- 危险命令: ${context.safetyViolations.join("; ")}`);
  }
  return lines.join("\n");
}

/** 用 DeepEval 的 GEval 给一次跑分打 0–1 的协作质量分，并附原因。 */
export async function judgeCase(
  evalCase: EvalCase,
  context: CaseContext,
  options: JudgeOptions = {},
): Promise<JudgeResult> {
  const threshold = options.threshold ?? 0.6;
  const modelOptions: { model: string; apiKey?: string; baseURL?: string } = {
    model: options.judgeModel ?? "deepseek-chat",
  };
  if (options.judgeApiKey !== undefined) modelOptions.apiKey = options.judgeApiKey;
  if (options.judgeBaseUrl !== undefined) modelOptions.baseURL = options.judgeBaseUrl;

  const metric = new GEval({
    name: "协作质量",
    criteria:
      "判断这个编程智能体是否完整、正确地完成了用户指令：调用了正确的工具、产出了要求的文件，且最终回复与实际情况一致。",
    evaluationParams: [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
    model: new DeepSeekModel(modelOptions),
    threshold,
  });

  const testCase = new LLMTestCase({
    input: contextToText(evalCase, context),
    actualOutput: context.finalOutput,
  });

  const score = await metric.measure(testCase);
  return {
    score,
    reason: metric.reason,
    success: metric.success ?? score >= threshold,
  };
}