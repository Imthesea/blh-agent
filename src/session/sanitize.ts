import type { ChatMessage } from "../contracts/types.js";

/** 给声明了但缺结果的 tool_call 补的合成结果内容（崩溃恢复场景）。 */
export const BACKFILL_TOOL_RESULT = "error: tool result missing (call was interrupted before completion)";

/** 去掉 name 无效的工具调用（防御性）。 */
export function stripMalformedToolCalls(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.tool_calls === undefined || message.tool_calls.length === 0) {
      return message;
    }
    const valid = message.tool_calls.filter(
      (call) => typeof call.function?.name === "string" && call.function.name.length > 0,
    );
    if (valid.length === message.tool_calls.length) return message;
    return { ...message, tool_calls: valid };
  });
}

/** 去掉没有对应前置 tool_call 的孤儿 tool 结果，以及重复结果（防御性）。 */
export function dropOrphanToolResults(messages: readonly ChatMessage[]): ChatMessage[] {
  const declared = new Set<string>();
  const fulfilled = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (call.id) {
          declared.add(call.id);
          // 后续出现同名调用时，前面的结果不再视为已满足（防御服务端复用 id）。
          fulfilled.delete(call.id);
        }
      }
      result.push(message);
    } else if (message.role === "tool") {
      const id = message.tool_call_id ?? "";
      if (id === "" || !declared.has(id) || fulfilled.has(id)) {
        continue; // 孤儿或重复结果，丢弃
      }
      fulfilled.add(id);
      result.push(message);
    } else {
      result.push(message);
    }
  }
  return result;
}

/** 给声明了但缺结果的 tool_call 补合成结果。崩溃恢复场景下缺失结果总在尾部（工具顺序执行）。 */
export function backfillMissingToolResults(messages: readonly ChatMessage[]): ChatMessage[] {
  const needed = new Map<string, { name: string; remaining: number }>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (!call.id) continue;
        const entry = needed.get(call.id) ?? { name: call.function.name, remaining: 0 };
        entry.remaining += 1;
        needed.set(call.id, entry);
      }
    } else if (message.role === "tool" && message.tool_call_id) {
      const entry = needed.get(message.tool_call_id);
      if (entry) {
        entry.remaining -= 1;
        if (entry.remaining <= 0) needed.delete(message.tool_call_id);
      }
    }
  }
  if (needed.size === 0) return [...messages];
  const tail: ChatMessage[] = [];
  for (const [callId, entry] of needed) {
    for (let i = 0; i < entry.remaining; i++) {
      tail.push({ role: "tool", tool_call_id: callId, name: entry.name, content: BACKFILL_TOOL_RESULT });
    }
  }
  return [...messages, ...tail];
}

/**
 * replay 前清洗：去非法调用 → 去孤儿结果 → 补缺失结果。
 * 纯读侧、幂等、不改入参；只作用于发送给模型的载荷，不写回 transcript、不参与压缩下标映射（R5）。
 */
export function sanitizeReplay(messages: readonly ChatMessage[]): ChatMessage[] {
  const stripped = stripMalformedToolCalls(messages);
  const dropped = dropOrphanToolResults(stripped);
  return backfillMissingToolResults(dropped);
}