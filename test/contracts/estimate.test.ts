import { describe, it, expect } from "vitest";
import {
  UNCOUNTED_RATIO,
  estimatePromptTokens,
  TokenEstimator,
} from "../../src/contracts/estimate.js";
import type { ChatMessage, ToolDefinition } from "../../src/contracts/types.js";

const tool: ToolDefinition = {
  name: "read_file",
  description: "读取文件内容",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  handler: async () => "ok",
};

describe("estimate", () => {
  it("空输入返回 0", () => {
    expect(estimatePromptTokens([])).toBe(0);
    expect(estimatePromptTokens([], [])).toBe(0);
  });

  it("工具定义会计入 prompt 估算", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    expect(estimatePromptTokens(messages, [tool])).toBeGreaterThan(estimatePromptTokens(messages));
  });

  it("assistant 的工具调用计入消息估算", () => {
    const withCall: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
        ],
      },
    ];
    const plain: ChatMessage[] = [{ role: "assistant", content: null }];
    expect(estimatePromptTokens(withCall)).toBeGreaterThan(estimatePromptTokens(plain));
  });
});

describe("TokenEstimator", () => {
  it("未校准前比例为 UNCOUNTED_RATIO", () => {
    const estimator = new TokenEstimator();
    expect(estimator.ratio("m")).toBe(UNCOUNTED_RATIO);
    expect(estimator.learnedRatio("m")).toBe(0);
  });

  it("scale 不小于原始估算，且等于原始 × 比例", () => {
    const estimator = new TokenEstimator();
    const raw = 1000;
    expect(estimator.scale("m", raw)).toBe(Math.ceil(raw * UNCOUNTED_RATIO));
    expect(estimator.scale("m", raw)).toBeGreaterThanOrEqual(raw);
  });

  it("observe 只增不减（历史最大比例）", () => {
    const estimator = new TokenEstimator();
    estimator.observe("m", 1000, 2000); // 2.0
    expect(estimator.learnedRatio("m")).toBe(2);
    estimator.observe("m", 1000, 1500); // 1.5 → 不回退
    expect(estimator.learnedRatio("m")).toBe(2);
    estimator.observe("m", 1000, 3000); // 3.0 → 抬升
    expect(estimator.learnedRatio("m")).toBe(3);
    expect(estimator.ratio("m")).toBe(3);
  });

  it("observe 忽略非法输入", () => {
    const estimator = new TokenEstimator();
    estimator.observe("m", 0, 100);
    estimator.observe("m", 100, 0);
    estimator.observe("m", Number.NaN, 100);
    estimator.observe("m", 100, Number.NaN);
    expect(estimator.learnedRatio("m")).toBe(0);
  });

  it("不同模型互不影响", () => {
    const estimator = new TokenEstimator();
    estimator.observe("a", 1000, 3000);
    expect(estimator.learnedRatio("a")).toBe(3);
    expect(estimator.learnedRatio("b")).toBe(0);
    expect(estimator.ratio("b")).toBe(UNCOUNTED_RATIO);
  });
});
