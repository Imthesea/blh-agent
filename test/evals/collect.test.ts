import { describe, it, expect } from "vitest";
import { runVerify } from "../../evals/collect.js";

describe("runVerify", () => {
  it("退出码 0 视为通过，非 0 视为失败", () => {
    expect(runVerify(process.cwd(), "node --version")).toBe(true);
    expect(runVerify(process.cwd(), "node --definitely-not-a-real-flag")).toBe(false);
  });
});