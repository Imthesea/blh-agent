import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ChatProvider,
  ChatUsage,
  Config,
  ProviderStreamEvent,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import { parseToolArguments } from "../core/parse-args.js";
import { withRetry } from "./retry.js";
import { createLogger } from "@blh/logger";

const log = createLogger("providers.anthropic");

const DEFAULT_MAX_TOKENS = 8192;

/** 最小化 client 结构：provider 只依赖 messages.create，便于测试注入 */
export interface AnthropicClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
    create(
      params: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<Anthropic.MessageStreamEvent>>;
  };
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const result: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system = (system ? system + "\n\n" : "") + (message.content ?? "");
      continue;
    }
    if (message.role === "user") {
      result.push({ role: "user", content: message.content ?? "" });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
      result.push({ role: "assistant", content: blocks });
      continue;
    }
    // role === "tool"
    result.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content ?? "" }],
    });
  }
  return { ...(system !== undefined ? { system } : {}), messages: result };
}

function fromAnthropicMessage(message: Anthropic.Message): ChatMessage {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export class AnthropicProvider implements ChatProvider {
  private readonly client: AnthropicClient;
  private last: ChatUsage | undefined;

  constructor(
    private readonly config: Config,
    client?: AnthropicClient,
  ) {
    this.client =
      client ??
      new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
  }

  private createOptions(signal?: AbortSignal): { signal?: AbortSignal } | undefined {
    return signal !== undefined ? { signal } : undefined;
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): Promise<ChatMessage> {
    log.debug("chat request", { model: this.config.model, messages: messages.length, tools: tools.length });
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const response = await withRetry(() =>
      this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system !== undefined ? { system } : {}),
          messages: anthropicMessages,
          ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
        },
        this.createOptions(signal),
      ),
    );
    log.debug("chat response", { toolCalls: response.content.filter((b) => b.type === "tool_use").length });
    if (response.usage) {
      this.last = { promptTokens: response.usage.input_tokens, completionTokens: response.usage.output_tokens };
    }
    return fromAnthropicMessage(response);
  }

  async chatCompletion(
    messages: ChatMessage[],
    maxTokens?: number,
  ): Promise<{ message: ChatMessage; usage: ChatUsage }> {
    log.debug("chatCompletion request", { model: this.config.model, messages: messages.length });
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const response = await withRetry(() =>
      this.client.messages.create({
        model: this.config.model,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system !== undefined ? { system } : {}),
        messages: anthropicMessages,
      }),
    );
    if (response.usage) {
      this.last = { promptTokens: response.usage.input_tokens, completionTokens: response.usage.output_tokens };
    }
    return {
      message: fromAnthropicMessage(response),
      usage: {
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    maxTokens?: number,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent> {
    log.debug("stream request", { model: this.config.model, messages: messages.length, tools: tools.length });
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const stream = await withRetry(() =>
      this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system !== undefined ? { system } : {}),
          messages: anthropicMessages,
          ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
          stream: true,
        },
        this.createOptions(signal),
      ),
    );

    let text = "";
    const calls = new Map<number, { id: string; name: string; partialJson: string }>();
    let usage: ChatUsage | undefined;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          calls.set(event.index, { id: block.id, name: block.name, partialJson: "" });
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          text += delta.text;
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          const acc = calls.get(event.index);
          if (acc) acc.partialJson += delta.partial_json;
        }
      } else if (event.type === "message_delta" && event.usage) {
        usage = { promptTokens: event.usage.input_tokens ?? 0, completionTokens: event.usage.output_tokens };
      }
    }

    const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.partialJson || "{}" },
    }));
    const message: ChatMessage = {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    yield { type: "done", message, ...(usage ? { usage } : {}) };
  }

  lastUsage(): ChatUsage | undefined {
    return this.last;
  }
}
