import type { ChatMessage, ToolDefinition } from "./types.js";

/**
 * 粗略的 token 估算，用于上下文规模判断。
 * 思路移植自 pi（MIT License, Copyright (c) 2025 Mario Zechner）：
 * 用 字符数 / 3.5 近似 token，工具调用参数按 JSON 长度计入。
 */

const CHARS_PER_TOKEN = 3.5;

/**
 * 固定放大系数：估算值在未学到真实比例前，统一乘以它留出余量。
 * 移植自 invisible_dots 的 prompt_count.py（UNCOUNTED_RATIO）。
 */
export const UNCOUNTED_RATIO = 1.35;

/** 粗略估算：按 UTF-16 码元长度 / 3.5。emoji 等增补平面字符会被双计，属有意取舍（避免为计数分配数组，校准会兜底）。 */
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

/** 单个工具定义的开销：只序列化 name/description/parameters，避开 handler 函数。 */
export function estimateToolDefinitionTokens(tool: ToolDefinition): number {
  const payload = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  return Math.ceil(safeJsonStringify(payload).length / CHARS_PER_TOKEN);
}

/** 工具定义总开销；未提供或空数组时返回 0。 */
export function estimateToolTokens(tools: readonly ToolDefinition[] | undefined): number {
  if (tools === undefined) return 0;
  let tokens = 0;
  for (const tool of tools) tokens += estimateToolDefinitionTokens(tool);
  return tokens;
}

/** 完整 prompt 的估算：消息 + 工具定义。空输入返回 0。 */
export function estimatePromptTokens(
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[],
): number {
  return estimateContextTokens(messages) + estimateToolTokens(tools);
}

/**
 * token 估算的每模型校准：用端点真实 usage（actual/estimated 的历史最大比例）
 * 放大估算，使预算趋近真实。校准状态仅进程内、按 model 键、单调不减、不持久化。
 */
export class TokenEstimator {
  private readonly learnedRatios = new Map<string, number>();

  /** 某模型用于放大估算的比例：max(UNCOUNTED_RATIO, 已学到的历史最大比例)。 */
  ratio(model: string | undefined): number {
    const learned = model !== undefined ? (this.learnedRatios.get(model) ?? 0) : 0;
    return Math.max(UNCOUNTED_RATIO, learned);
  }

  /** 已学到的某模型历史最大比例；未学到返回 0。 */
  learnedRatio(model: string): number {
    return this.learnedRatios.get(model) ?? 0;
  }

  /** 用一次真实 usage 校准：actual/estimated，只增不减。 */
  observe(model: string, estimatedTokens: number, actualTokens: number): void {
    if (!Number.isFinite(estimatedTokens) || !Number.isFinite(actualTokens)) return;
    if (estimatedTokens <= 0 || actualTokens <= 0) return;
    const ratio = actualTokens / estimatedTokens;
    const current = this.learnedRatios.get(model) ?? 0;
    if (ratio > current) this.learnedRatios.set(model, ratio);
  }

  /** 校准后的估算 = 原始估算 × ratio(model)。 */
  scale(model: string | undefined, estimatedTokens: number): number {
    return Math.ceil(estimatedTokens * this.ratio(model));
  }
}
