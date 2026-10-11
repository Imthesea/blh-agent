/**
 * 上下文超长（context overflow）的启发式判定。
 *
 * 关键词部分沿用原有实现；正则部分移植并适配自 pi
 * （MIT License, Copyright (c) 2025 Mario Zechner），覆盖各家厂商的报错措辞。
 */

/** 各厂商上下文超长的报错正则。 */
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

/** 非溢出的报错（限流、服务不可用等），即使同时命中溢出正则也排除。 */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/** 原有实现保留的关键词，覆盖 pi 正则没覆盖到的老用例（如 "maximum context"）。 */
const LEGACY_KEYWORDS = [
  "prompt_too_long",
  "too many tokens",
  "context length",
  "context_length_exceeded",
  "maximum context",
  "reduce the length",
  "prompt is too long",
  "number of tokens exceeds",
  "input length exceeds",
];

/** 启发式判定上下文超长：HTTP 400/413/422 + 报错文案命中。 */
export function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error)) return false;
  const status = (error as Error & { status: unknown }).status;
  if (status !== 400 && status !== 413 && status !== 422) return false;
  const text = error.message.toLowerCase();
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(text)) return true;
  return (
    LEGACY_KEYWORDS.some((keyword) => text.includes(keyword)) ||
    OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
  );
}