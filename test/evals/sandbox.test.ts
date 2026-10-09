import { describe, it, expect } from "vitest";
import { createSandboxHarness, caseNeedsFullTools, SANDBOX_FORBIDDEN_TOOLS } from "../../evals/sandbox.js";
import { MockProvider } from "../integration/helpers.js";
import type { Config } from "../../src/contracts/types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp/blh-sandbox",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

describe("评测沙箱", () => {
  it("safe 策略不暴露 bash，保留文件工具与 submit_result", () => {
    const harness = createSandboxHarness(config, new MockProvider([]), { policy: "safe" });
    const names = harness.tools.list().map((tool) => tool.name);
    expect(names).not.toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("glob");
    expect(names).toContain("submit_result");
  });

  it("full 策略暴露 bash", () => {
    const harness = createSandboxHarness(config, new MockProvider([]), { policy: "full" });
    expect(harness.tools.list().map((tool) => tool.name)).toContain("bash");
  });

  it("默认是 safe 策略", () => {
    const harness = createSandboxHarness(config, new MockProvider([]));
    expect(harness.tools.list().map((tool) => tool.name)).not.toContain("bash");
  });

  it("caseNeedsFullTools 识别引用被禁工具的用例", () => {
    expect(caseNeedsFullTools({ id: "x", input: "y", expect_tools: ["bash"] })).toBe(true);
    expect(caseNeedsFullTools({ id: "x", input: "y", expect_in_args: { bash: { command: "ls" } } })).toBe(true);
    expect(caseNeedsFullTools({ id: "x", input: "y", expect_tools: ["write_file"] })).toBe(false);
    expect(caseNeedsFullTools({ id: "x", input: "y" })).toBe(false);
  });

  it("SANDBOX_FORBIDDEN_TOOLS 包含 bash", () => {
    expect(SANDBOX_FORBIDDEN_TOOLS.has("bash")).toBe(true);
  });

  it("评测专用 systemPrompt 不提未注册的工具", () => {
    const harness = createSandboxHarness(config, new MockProvider([]), { policy: "safe" });
    const prompt = harness.systemPrompt;
    expect(prompt).not.toContain("spawn_teammate");
    expect(prompt).not.toContain("create_task");
    expect(prompt).not.toContain("schedule_cron");
    expect(prompt).not.toContain("todo_write");
    expect(prompt).toContain("blh");
  });
});