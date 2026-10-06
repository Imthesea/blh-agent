import type { ChatMessage } from "../contracts/types.js";

export function messageText(message: ChatMessage): string {
  const content = message.content;
  return typeof content === "string" ? content : "";
}

export function extractJsonArray(text: string): unknown[] {
  for (let position = 0; position < text.length; position++) {
    if (text.charAt(position) !== "[") {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = position; end < text.length; end++) {
      const character = text.charAt(end);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "[") {
        depth += 1;
      } else if (character === "]") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(text.slice(position, end + 1));
            if (Array.isArray(value)) {
              return value;
            }
          } catch {
            // 该位置解析失败则继续尝试下一个 "["
          }
          break;
        }
      }
    }
  }
  return [];
}
