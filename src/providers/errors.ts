const PROMPT_TOO_LONG_KEYWORDS = [
  // OpenAI 兼容端常见报错
  "prompt_too_long",
  "too many tokens",
  "context length",
  "context_length_exceeded",
  "maximum context",
  "reduce the length",
  // Anthropic 原生端常见报错
  "prompt is too long",
  "number of tokens exceeds",
  "input length exceeds",
] as const;

/** 启发式判定上下文超长：HTTP 400/413/422 + 错误体关键词（各家格式不一） */
export function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error)) return false;
  const status = (error as Error & { status: unknown }).status;
  if (status !== 400 && status !== 413 && status !== 422) return false;
  const text = error.message.toLowerCase();
  return PROMPT_TOO_LONG_KEYWORDS.some((keyword) => text.includes(keyword));
}
