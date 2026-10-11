import type { ChatMessage } from "./types.js";

/**
 * 粗略的 token 估算，用于上下文规模判断。
 * 思路移植自 pi（MIT License, Copyright (c) 2025 Mario Zechner）：
 * 用 字符数 / 3.5 近似 token，工具调用参数按 JSON 长度计入。
 */

const CHARS_PER_TOKEN = 3.5;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = message.content?.length ?? 0;
  if (message.role === "assistant" && message.tool_calls !== undefined && message.tool_calls.length > 0) {
    chars += safeJsonStringify(message.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateContextTokens(messages: readonly ChatMessage[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}