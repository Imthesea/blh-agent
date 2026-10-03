/** workflow 基础:稳定 hash、极简 JSON Schema 校验、JSON 提取。 */
import { createHash } from "node:crypto";

export const MISS: unique symbol = Symbol("MISS");

export class WorkflowInputError extends Error {}

export function stableHash(s: string): bigint {
  return BigInt("0x" + createHash("sha256").update(s, "utf8").digest("hex"));
}

/** 递归排序键的确定性 JSON 序列化(替代 Python 的 json.dumps(sort_keys=True)) */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
}

export class SimpleJsonSchema {
  constructor(readonly schema: JsonSchema) {}

  validate(value: unknown, schema?: JsonSchema): [boolean, string | null] {
    const s = schema ?? this.schema;
    if (s.enum !== undefined && !s.enum.includes(value)) {
      return [false, `expected one of ${JSON.stringify(s.enum)}`];
    }
    const t = s.type;
    if (t === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [false, "expected object"];
      }
      const obj = value as Record<string, unknown>;
      for (const key of s.required ?? []) {
        if (!(key in obj)) return [false, `missing required key '${key}'`];
      }
      for (const [key, sub] of Object.entries(s.properties ?? {})) {
        if (key in obj) {
          const [ok, err] = this.validate(obj[key], sub);
          if (!ok) return [false, `${key}: ${err}`];
        }
      }
      return [true, null];
    }
    if (t === "array") {
      if (!Array.isArray(value)) return [false, "expected array"];
      const items = s.items;
      if (items !== undefined) {
        for (let i = 0; i < value.length; i++) {
          const [ok, err] = this.validate(value[i], items);
          if (!ok) return [false, `[${i}]: ${err}`];
        }
      }
      return [true, null];
    }
    if (t === "string") {
      return typeof value === "string" ? [true, null] : [false, "expected string"];
    }
    if (t === "boolean") {
      return typeof value === "boolean" ? [true, null] : [false, "expected boolean"];
    }
    if (t === "number" || t === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return [false, "expected number"];
      }
      if (t === "integer" && !Number.isInteger(value)) {
        return [false, "expected integer"];
      }
      return [true, null];
    }
    return [true, null];
  }
}

/** 从 start 起的首个 '{' 提取首个平衡 JSON 对象(尊重字符串转义),失败返回 null */
function extractFirstBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 提取 agent 返回的 JSON:支持围栏代码块,失败时扫首个 '{' 起的对象。 */
export function parseRunnerJson(text: string): unknown {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    const lines = stripped.split(/\r?\n/);
    const body = lines.slice(1);
    if (body.length > 0 && body[body.length - 1]?.trim() === "```") body.pop();
    stripped = body.join("\n").trim();
  }
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    if (start === -1) throw new WorkflowInputError("workflow agent returned invalid JSON");
    const extracted = extractFirstBalancedObject(stripped, start);
    if (extracted === null) throw new WorkflowInputError("workflow agent returned invalid JSON");
    return JSON.parse(extracted);
  }
}
