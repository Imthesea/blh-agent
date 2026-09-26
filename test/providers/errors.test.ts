import { describe, it, expect } from "vitest";

const badRequest = (text: string) => Object.assign(new Error(text), { status: 400 });
const err = (status: number, text: string) => Object.assign(new Error(text), { status });

describe("isPromptTooLong", () => {
  it("400 + 关键词判定为上下文超长（OpenAI 兼容）", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(badRequest("prompt_too_long: ..."))).toBe(true);
    expect(isPromptTooLong(badRequest("This model's maximum context length is 65536"))).toBe(true);
    expect(isPromptTooLong(badRequest("too many tokens in prompt"))).toBe(true);
    expect(isPromptTooLong(badRequest("context_length_exceeded"))).toBe(true);
    expect(isPromptTooLong(badRequest("invalid api key"))).toBe(false);
  });

  it("Anthropic 关键词也判定为超长", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(badRequest("prompt is too long"))).toBe(true);
    expect(isPromptTooLong(badRequest("number of tokens exceeds"))).toBe(true);
    expect(isPromptTooLong(badRequest("input length exceeds"))).toBe(true);
  });

  it("413/422 + 关键词也判定为超长", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(err(413, "prompt_too_long"))).toBe(true);
    expect(isPromptTooLong(err(422, "context length exceeded"))).toBe(true);
    expect(isPromptTooLong(err(500, "prompt_too_long"))).toBe(false);
  });

  it("非 Error / 无 status 不判定", async () => {
    const { isPromptTooLong } = await import("../../src/providers/errors.js");
    expect(isPromptTooLong(new Error("prompt_too_long"))).toBe(false);
    expect(isPromptTooLong("prompt_too_long")).toBe(false);
  });
});
