/** 判断一个值是不是普通对象（排除 null 和数组），用于校验解析出的 JSON */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 tool_call 的 JSON arguments：非法 JSON 或非对象一律返回 {} */
export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
