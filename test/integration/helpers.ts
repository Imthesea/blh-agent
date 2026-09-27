import type { ChatMessage, ChatProvider, ChatUsage, ToolDefinition } from "../../src/core/types.js";

/** 脚本化 provider：每次 chat 弹出队列头部消息 */
export class MockProvider implements ChatProvider {
  calls = 0;
  usage: ChatUsage | undefined = { promptTokens: 10, completionTokens: 5 };

  lastUsage(): ChatUsage | undefined {
    return this.usage;
  }
  constructor(private readonly script: ChatMessage[]) {}
  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _maxTokens?: number,
    _signal?: AbortSignal,
  ): Promise<ChatMessage> {
    this.calls += 1;
    const next = this.script.shift();
    if (!next) throw new Error("MockProvider: script exhausted");
    return next;
  }
}

export function makeToolCallMessage(
  name: string,
  args: Record<string, unknown>,
  id = "call_1",
): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

export function makeTextMessage(text: string): ChatMessage {
  return { role: "assistant", content: text };
}
