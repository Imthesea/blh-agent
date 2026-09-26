import OpenAI from "openai";
import type {
  ChatMessage,
  ChatProvider,
  ChatUsage,
  Config,
  ProviderStreamEvent,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import { withRetry } from "./retry.js";
import { createLogger } from "@blh/logger";

const log = createLogger("providers.openai");

/** 最小化的 client 结构：provider 只依赖 chat.completions.create，便于测试注入 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        params: OpenAI.ChatCompletionCreateParamsNonStreaming,
        options?: { timeout?: number; signal?: AbortSignal },
      ): Promise<OpenAI.ChatCompletion>;
      create(
        params: OpenAI.ChatCompletionCreateParamsStreaming,
        options?: { timeout?: number; signal?: AbortSignal },
      ): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
    };
  };
}

function toOpenAIMessage(message: ChatMessage): OpenAI.ChatCompletionMessageParam {
  const content = message.content ?? "";
  switch (message.role) {
    case "system":
      return { role: "system", content };
    case "user":
      return { role: "user", content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      };
    case "tool":
      return { role: "tool", content, tool_call_id: message.tool_call_id ?? "" };
  }
}

function fromOpenAIMessage(message: OpenAI.ChatCompletionMessage): ChatMessage {
  const toolCalls: ToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    // 防御 custom tool call 联合类型：本项目只使用 function tool
    if (call.type !== "function") continue;
    toolCalls.push({
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    });
  }
  return {
    role: "assistant",
    content: message.content,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export class OpenAICompatProvider implements ChatProvider {
  private readonly client: ChatCompletionsClient;

  constructor(
    private readonly config: Config,
    client?: ChatCompletionsClient,
  ) {
    this.client =
      client ??
      new OpenAI({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
  }

  private createOptions(signal?: AbortSignal): { timeout: number; signal?: AbortSignal } {
    if (signal === undefined) return { timeout: 600_000 };
    return { timeout: 600_000, signal };
  }

  private async createCompletion(
    params: OpenAI.ChatCompletionCreateParamsNonStreaming,
    signal?: AbortSignal,
  ): Promise<OpenAI.ChatCompletion> {
    return withRetry(() =>
      this.client.chat.completions.create(params, this.createOptions(signal)),
    );
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): Promise<ChatMessage> {
    log.debug("chat request", { model: this.config.model, messages: messages.length, tools: tools.length });
    const response = await this.createCompletion({
      model: this.config.model,
      messages: messages.map(toOpenAIMessage),
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    }, signal);
    const message = response.choices[0]?.message;
    if (!message) throw new Error("provider returned no choices");
    log.debug("chat response", { toolCalls: message.tool_calls?.length ?? 0 });
    return fromOpenAIMessage(message);
  }

  /** 无 tools 单轮,额外返回 usage(供 workflow runner 记账)。 */
  async chatCompletion(
    messages: ChatMessage[],
    maxTokens?: number,
  ): Promise<{ message: ChatMessage; usage: ChatUsage }> {
    log.debug("chatCompletion request", { model: this.config.model, messages: messages.length });
    const response = await this.createCompletion({
      model: this.config.model,
      messages: messages.map(toOpenAIMessage),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("provider returned no choices");
    log.debug("chatCompletion response", {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    });
    return {
      message: fromOpenAIMessage(message),
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
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
    const stream = await withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: messages.map(toOpenAIMessage),
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        },
        this.createOptions(signal),
      ),
    );

    let text = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: ChatUsage | undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const acc = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        calls.set(tc.index, acc);
        yield {
          type: "tool_call_delta",
          index: tc.index,
          ...(tc.id ? { id: tc.id } : {}),
          ...(tc.function?.name ? { name: tc.function.name } : {}),
          ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
        };
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
    }

    const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
    const message: ChatMessage = {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    yield { type: "done", message, ...(usage ? { usage } : {}) };
  }
}
