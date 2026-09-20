import { describe, it, expect, vi } from "vitest";
import type { Config, ToolDefinition } from "../../src/core/types.js";

const config: Config = {
  apiKey: "sk-test",
  baseUrl: "http://fake/v1",
  model: "test-model",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeClient(create: ReturnType<typeof vi.fn>) {
  return { chat: { completions: { create } } };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "echo tool",
  parameters: { type: "object" },
  handler: async () => "",
};

describe("OpenAIProvider", () => {
  it("calls chat.completions.create with model/messages/tools and returns first message", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const message = { role: "assistant", content: "hi" };
    const create = vi.fn().mockResolvedValue({ choices: [{ message }] });
    const provider = new OpenAIProvider(config, makeClient(create));
    const result = await provider.chat([{ role: "user", content: "hello" }], [echoTool]);
    expect(create).toHaveBeenCalledWith(
      {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: { name: "echo", description: "echo tool", parameters: { type: "object" } },
          },
        ],
      },
      { timeout: 600_000 },
    );
    expect(result).toEqual({ role: "assistant", content: "hi" });
  });

  it("passes tools as undefined when empty", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const provider = new OpenAIProvider(config, makeClient(create));
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(create.mock.calls[0]?.[0].tools).toBeUndefined();
  });

  it("retries 429 via withRetry", async () => {
    vi.useFakeTimers();
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    const provider = new OpenAIProvider(config, makeClient(create));
    const chatPromise = provider.chat([{ role: "user", content: "hi" }], []);
    await vi.runAllTimersAsync();
    await expect(chatPromise).resolves.toEqual({ role: "assistant", content: "ok" });
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("passes max_tokens when provided", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });
    const provider = new OpenAIProvider(config, makeClient(create));
    await provider.chat([{ role: "user", content: "hi" }], [], 200);
    expect(create.mock.calls[0]?.[0].max_tokens).toBe(200);
  });

  it("omits max_tokens when not provided", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });
    const provider = new OpenAIProvider(config, makeClient(create));
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
  });

  it("passes signal through to chat.completions.create", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { role: "assistant", content: "hi" } }] });
    const provider = new OpenAIProvider(config, makeClient(create));
    const controller = new AbortController();
    await provider.chat([{ role: "user", content: "hi" }], [], undefined, controller.signal);
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      timeout: 600_000,
      signal: controller.signal,
    });
  });

  it("passes signal through in stream", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield { choices: [{ index: 0, delta: { content: "hi" } }] };
      })(),
    );
    const provider = new OpenAIProvider(config, makeClient(create));
    const controller = new AbortController();
    for await (const _ of provider.stream!([{ role: "user", content: "hi" }], [], undefined, controller.signal)) {
      /* 消费完 */
    }
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      timeout: 600_000,
      signal: controller.signal,
    });
  });
});

describe("isPromptTooLong", () => {
  it("400 + 关键词判定为上下文超长", async () => {
    const { isPromptTooLong } = await import("../../src/providers/openai.js");
    const badRequest = (text: string) =>
      Object.assign(new Error(text), { status: 400 });
    expect(isPromptTooLong(badRequest("prompt_too_long: ..."))).toBe(true);
    expect(
      isPromptTooLong(badRequest("This model's maximum context length is 65536")),
    ).toBe(true);
    expect(isPromptTooLong(badRequest("too many tokens in prompt"))).toBe(true);
    expect(isPromptTooLong(badRequest("context_length_exceeded"))).toBe(true);
    expect(isPromptTooLong(badRequest("invalid api key"))).toBe(false);
    expect(isPromptTooLong(new Error("prompt_too_long"))).toBe(false); // 无 400
    expect(isPromptTooLong("prompt_too_long")).toBe(false); // 非 Error
  });

  it("413/422 + 关键词也判定为超长", async () => {
    const { isPromptTooLong } = await import("../../src/providers/openai.js");
    const err = (status: number, text: string) =>
      Object.assign(new Error(text), { status });
    expect(isPromptTooLong(err(413, "prompt_too_long"))).toBe(true);
    expect(isPromptTooLong(err(422, "context length exceeded"))).toBe(true);
    expect(isPromptTooLong(err(500, "prompt_too_long"))).toBe(false);
  });
});

describe("OpenAIProvider.stream", () => {
  it("streams text deltas and yields assembled message with usage", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const chunks = [
      { choices: [{ index: 0, delta: { content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ];
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );
    const provider = new OpenAIProvider(config, makeClient(create));
    const events = [];
    for await (const event of provider.stream([{ role: "user", content: "hi" }], [])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "done",
        message: { role: "assistant", content: "Hello" },
        usage: { promptTokens: 10, completionTokens: 2 },
      },
    ]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, stream_options: { include_usage: true } }),
      { timeout: 600_000 },
    );
  });

  it("accumulates tool_call deltas by index into assembled tool_calls", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
      { choices: [] },
    ];
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );
    const provider = new OpenAIProvider(config, makeClient(create));
    const events = [];
    for await (const event of provider.stream([{ role: "user", content: "hi" }], [echoTool])) {
      events.push(event);
    }
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({
      type: "done",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: '{"a":1}' } },
        ],
      },
    });
    expect(events.filter((e) => e.type === "tool_call_delta")).toHaveLength(3);
  });
});
