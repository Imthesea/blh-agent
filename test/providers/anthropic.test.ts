import { describe, it, expect, vi } from "vitest";
import type { Config, ToolDefinition } from "../../src/core/types.js";

const config: Config = {
  apiKey: "sk-test",
  model: "claude-test",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeClient(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "e",
  parameters: { type: "object" },
  handler: async () => "",
};

describe("AnthropicProvider", () => {
  it("chat 转换消息（system 顶层 / tool_use / tool_result）并回传 tool_calls", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "echo", input: { a: 1 } },
      ],
      model: "claude-test",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = new AnthropicProvider(config, makeClient(create));
    const result = await provider.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok", tool_calls: [{ id: "t1", type: "function", function: { name: "echo", arguments: '{"a":1}' } }] },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
      [echoTool],
    );
    expect(result.tool_calls?.[0]).toEqual({ id: "t1", type: "function", function: { name: "echo", arguments: '{"a":1}' } });
    const params = create.mock.calls[0]?.[0];
    expect(params.system).toBe("sys");
    expect(params.max_tokens).toBe(8192);
    expect(params.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "echo", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
    ]);
    expect(params.tools).toEqual([{ name: "echo", description: "e", input_schema: { type: "object" } }]);
  });

  it("chatCompletion 返回 usage", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue({
      id: "msg_1", type: "message", role: "assistant",
      content: [{ type: "text", text: "hi" }], model: "x",
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = new AnthropicProvider(config, makeClient(create));
    const { message, usage } = await provider.chatCompletion!([{ role: "user", content: "hi" }]);
    expect(message.content).toBe("hi");
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("stream 拼装 text 并 yield done + usage", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_delta", delta: { stop_reason: null }, usage: { input_tokens: 10, output_tokens: 2 } };
        yield { type: "message_stop" };
      })(),
    );
    const provider = new AnthropicProvider(config, makeClient(create));
    const events: unknown[] = [];
    for await (const e of provider.stream([{ role: "user", content: "hi" }], [])) events.push(e);
    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "done", message: { role: "assistant", content: "Hello" }, usage: { promptTokens: 10, completionTokens: 2 } },
    ]);
  });

  it("stream 拼装 tool_use 的 input_json_delta 为 tool_calls", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } };
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } };
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_stop" };
      })(),
    );
    const provider = new AnthropicProvider(config, makeClient(create));
    const events: unknown[] = [];
    for await (const e of provider.stream([{ role: "user", content: "hi" }], [echoTool])) events.push(e);
    const done = events.find((e) => (e as { type: string }).type === "done") as { message: { tool_calls: unknown[] } };
    expect(done.message.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "echo", arguments: '{"a":1}' } },
    ]);
  });
});

describe("lastUsage", () => {
  it("chat() 后返回最近一次 usage", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = new AnthropicProvider(config, makeClient(create));
    expect(provider.lastUsage()).toBeUndefined();
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(provider.lastUsage()).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("chatCompletion() 后返回最近一次 usage", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 3 },
    });
    const provider = new AnthropicProvider(config, makeClient(create));
    await provider.chatCompletion?.([{ role: "user", content: "hi" }]);
    expect(provider.lastUsage()).toEqual({ promptTokens: 4, completionTokens: 3 });
  });
});
