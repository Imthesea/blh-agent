import { describe, it, expect } from "vitest";
import { judgeCase, hasJudgeKey } from "../../evals/judge.js";
import type { CaseContext, EvalCase } from "../../evals/check.js";

const judgeConfigured = hasJudgeKey();

describe.skipIf(!judgeConfigured)("LLM judge（需 DEEPSEEK_API_KEY）", () => {
  it("对完成度高的上下文给 0–1 分并附原因", async () => {
    const evalCase: EvalCase = { id: "judge-smoke", input: "创建 hello.txt 写入 world" };
    const context: CaseContext = {
      toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "world" } }],
      tasksCompleted: 0,
      files: new Map([["hello.txt", "world"]]),
      finalOutput: "已创建 hello.txt 并写入 world",
      safetyViolations: [],
    };
    const result = await judgeCase(evalCase, context);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(typeof result.reason).toBe("string");
  }, 120000);
});