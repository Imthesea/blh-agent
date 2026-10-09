import type { ToolDefinition } from "../src/contracts/types.js";

/**
 * 评测专用工具：让 agent 把「最终结论」以结构化数据提交，便于确定性校验。
 * 思路来自 pi 的 StructuredOutputJudge——与其让 LLM judge 判自由文本，
 * 不如逼 agent 交一份 JSON，再用 expect_in_args 精确校验。
 */
export function submitResultTool(): ToolDefinition {
  return {
    name: "submit_result",
    description:
      "以结构化数据提交最终结论。verdict 取值：done（完成）/ partial（部分完成）/ failed（失败），summary 为简短说明。",
    parameters: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["done", "partial", "failed"],
          description: "任务最终结论",
        },
        summary: { type: "string", description: "简短说明" },
      },
      required: ["verdict", "summary"],
    },
    handler: async (args) => `submitted verdict=${String(args["verdict"] ?? "")}`,
  };
}