import { truncateChars } from "./truncate.js";

/** 截断长文本，保护事件体积。按字符边界截断，避免劈开 emoji 等代理对。 */
export function summarize(text: string, max = 500): string {
  if (text.length <= max) return text;
  return truncateChars(text, max) + "…";
}
