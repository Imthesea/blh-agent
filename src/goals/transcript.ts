/** goal transcript:按 OpenAI 消息格式渲染会话文本。 */
import type { ChatMessage } from "../contracts/types.js";

export function plainContent(message: ChatMessage): string {
  const role = message.role;
  const content = message.content;
  if (role === "assistant") {
    const parts: string[] = [];
    if (content) parts.push(String(content));
    for (const call of message.tool_calls ?? []) {
      parts.push(`[tool_call ${call.function.name} ${call.function.arguments}]`);
    }
    return parts.join("\n");
  }
  if (role === "tool") {
    return `[tool_result ${content ?? ""}]`;
  }
  return String(content ?? "");
}

export function transcriptText(messages: ChatMessage[], maxCharacters = 24000): string {
  const rendered = messages.map((m) => `${m.role.toUpperCase()}:\n${plainContent(m)}`);
  const selected: string[] = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const item = rendered[i] ?? "";
    const itemSize = item.length + 2;
    if (selected.length === 0 && itemSize > maxCharacters) {
      const marker = "\n...[middle omitted]...\n";
      const available = Math.max(0, maxCharacters - marker.length);
      if (available === 0) {
        selected.push(marker.slice(0, maxCharacters));
      } else {
        const head = Math.floor((available * 3) / 4);
        const tail = available - head;
        selected.push(item.slice(0, head) + marker + item.slice(-tail));
      }
      break;
    }
    if (selected.length > 0 && size + itemSize > maxCharacters) break;
    selected.push(item);
    size += itemSize;
  }
  return selected.reverse().join("\n\n");
}
