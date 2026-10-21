import type { ChatMessage } from "../contracts/types.js";

/**
 * 把会话消息投影渲染成人类可读 markdown（纯函数、按需调用，不再 eager 落盘）。
 * 跳过 system 与 isInternal；工具调用与工具结果原样展开。
 */
export function renderSessionMarkdown(messages: readonly ChatMessage[]): string {
  const sections: string[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.isInternal === true) continue;
    if (message.role === "assistant" && message.tool_calls !== undefined && message.tool_calls.length > 0) {
      const calls = message.tool_calls
        .map((call) => `${call.function.name}(${call.function.arguments})`)
        .join("\n");
      sections.push(`### assistant\n${calls}`);
      if (message.content) sections.push(message.content);
    } else if (message.role === "tool") {
      sections.push(`### tool [${message.tool_call_id ?? ""}]\n${message.content ?? ""}`);
    } else {
      sections.push(`### ${message.role}\n${message.content ?? ""}`);
    }
  }
  return `${sections.join("\n\n")}\n\n`;
}
