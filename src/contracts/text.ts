/** 截断长文本，保护事件体积。 */
export function summarize(text: string, max = 500): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}
