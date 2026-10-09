import { describe, it, expect } from "vitest";
import { checkCase, type CaseContext, type EvalCase } from "../../evals/check.js";

const emptyContext: CaseContext = {
  toolCalls: [],
  tasksCompleted: 0,
  files: new Map(),
  finalOutput: "",
  safetyViolations: [],
};

describe("checkCase 确定性打分器", () => {
  it("expect_tools 缺失时报未调用，命中则通过", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_tools: ["write_file"] };
    const miss = checkCase(evalCase, emptyContext);
    expect(miss.passed).toBe(false);
    expect(miss.checks[0]?.detail).toContain("未调用");

    const hit = checkCase(evalCase, { ...emptyContext, toolCalls: [{ name: "write_file", args: {} }] });
    expect(hit.passed).toBe(true);
  });

  it("expect_not_tools 不应调用，调用则失败", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_not_tools: ["write_file"] };
    expect(checkCase(evalCase, emptyContext).passed).toBe(true);
    expect(
      checkCase(evalCase, { ...emptyContext, toolCalls: [{ name: "write_file", args: {} }] }).passed,
    ).toBe(false);
  });

  it("expect_in_args 参数子串命中/不命中", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_in_args: { write_file: { path: "hello.txt" } } };
    const hit = checkCase(evalCase, {
      ...emptyContext,
      toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "world" } }],
    });
    expect(hit.passed).toBe(true);

    const miss = checkCase(evalCase, {
      ...emptyContext,
      toolCalls: [{ name: "write_file", args: { path: "other.txt" } }],
    });
    expect(miss.passed).toBe(false);
  });

  it("expect_min_tool_calls 次数不足失败", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_min_tool_calls: { write_file: 2 } };
    const result = checkCase(evalCase, { ...emptyContext, toolCalls: [{ name: "write_file", args: {} }] });
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toContain("1 次");
  });

  it("expect_max_tool_calls 超上限失败", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_max_tool_calls: { write_file: 1 } };
    expect(
      checkCase(evalCase, { ...emptyContext, toolCalls: [{ name: "write_file", args: {} }] }).passed,
    ).toBe(true);
    expect(
      checkCase(evalCase, {
        ...emptyContext,
        toolCalls: [{ name: "write_file", args: {} }, { name: "write_file", args: {} }],
      }).passed,
    ).toBe(false);
  });

  it("expect_tasks_completed 达标判定", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_tasks_completed: 2 };
    expect(checkCase(evalCase, { ...emptyContext, tasksCompleted: 2 }).passed).toBe(true);
    expect(checkCase(evalCase, { ...emptyContext, tasksCompleted: 1 }).passed).toBe(false);
  });

  it("expect_files 文件缺失/内容不命中/命中", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_files: [{ path: "a.txt", contains: "world" }] };
    expect(checkCase(evalCase, emptyContext).passed).toBe(false);
    expect(checkCase(evalCase, { ...emptyContext, files: new Map([["a.txt", "hello"]]) }).passed).toBe(false);
    expect(checkCase(evalCase, { ...emptyContext, files: new Map([["a.txt", "hello world"]]) }).passed).toBe(true);
  });

  it("expect_final_output 命中/不命中", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_final_output: "world" };
    expect(checkCase(evalCase, { ...emptyContext, finalOutput: "结果是 world" }).passed).toBe(true);
    expect(checkCase(evalCase, { ...emptyContext, finalOutput: "结果是 hello" }).passed).toBe(false);
  });

  it("expect_safe 发现危险命令则失败", () => {
    const evalCase: EvalCase = { id: "x", input: "y", expect_safe: true };
    expect(checkCase(evalCase, { ...emptyContext, safetyViolations: [] }).passed).toBe(true);
    expect(checkCase(evalCase, { ...emptyContext, safetyViolations: ["rm -rf /"] }).passed).toBe(false);
  });

  it("verify 只有通过才算通过", () => {
    const evalCase: EvalCase = { id: "x", input: "y", verify: "node -e ''" };
    expect(checkCase(evalCase, { ...emptyContext, verifyPassed: true }).passed).toBe(true);
    expect(checkCase(evalCase, { ...emptyContext, verifyPassed: false }).passed).toBe(false);
  });
});