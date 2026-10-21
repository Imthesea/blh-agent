import type { ProviderDefinition, ProviderId } from "../contracts/types.js";
import { readEnv } from "../config/env.js";

/**
 * 内置 provider 描述表。catalog 顺序 = 自动检测优先级（deepseek 第一保证老用户升级不变）。
 *
 * contextWindow / maxOutputTokens 为保守的最佳估计（token 数），实现前应按各厂商
 * 官方文档再核实一次；未填或未知 provider 由 resolveContextWindow / resolveMaxOutputTokens
 * 回退到保守默认。
 */
const builtin: ProviderDefinition[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
    defaultModel: "deepseek-chat",
    contextWindow: 65536,
    maxOutputTokens: 8192,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-5",
    contextWindow: 200000,
    maxOutputTokens: 64000,
  },
  {
    id: "qwen",
    name: "Qwen",
    api: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY"],
    defaultModel: "qwen-max",
    contextWindow: 32768,
    maxOutputTokens: 8192,
  },
  {
    id: "kimi",
    name: "Kimi",
    api: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    defaultModel: "moonshot-v1-8k",
    contextWindow: 8192,
    maxOutputTokens: 4096,
  },
];

const providers: ProviderDefinition[] = [...builtin];

/** 未知/未提供窗口时的保守默认值（宁可偏小，避免发出超窗请求）。 */
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** 把值安全解析为正整数；非法或 ≤0 返回 undefined。 */
function positiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** 解析某 provider 的上下文窗口：override 优先，其次 env，再其次 provider 字段，最后保守默认。 */
export function resolveContextWindow(provider: ProviderDefinition | undefined, override?: number): number {
  if (override !== undefined) {
    const value = positiveInt(override);
    if (value !== undefined) return value;
  }
  const env = positiveInt(readEnv("BLH_CONTEXT_WINDOW"));
  if (env !== undefined) return env;
  const fromProvider = positiveInt(provider?.contextWindow);
  if (fromProvider !== undefined) return fromProvider;
  return DEFAULT_CONTEXT_WINDOW;
}

/** 解析某 provider 的最大输出 token：override 优先，其次 env，再其次 provider 字段，最后保守默认。 */
export function resolveMaxOutputTokens(provider: ProviderDefinition | undefined, override?: number): number {
  if (override !== undefined) {
    const value = positiveInt(override);
    if (value !== undefined) return value;
  }
  const env = positiveInt(readEnv("BLH_MAX_OUTPUT_TOKENS"));
  if (env !== undefined) return env;
  const fromProvider = positiveInt(provider?.maxOutputTokens);
  if (fromProvider !== undefined) return fromProvider;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/** 非抛错查找：按 id 返回 provider 定义，找不到返回 undefined，供需要聚合诊断的调用方使用。 */
export function findProviderDefinition(id: string): ProviderDefinition | undefined {
  return providers.find((d) => d.id === id);
}

export function getProviderDefinition(id: string): ProviderDefinition {
  const def = findProviderDefinition(id);
  if (!def) {
    throw new Error(`未知 provider '${id}'（可用：${listProviders().join(", ")}）`);
  }
  return def;
}

export function listProviders(): ProviderId[] {
  return providers.map((d) => d.id);
}

export function registerProvider(def: ProviderDefinition): void {
  const idx = providers.findIndex((d) => d.id === def.id);
  if (idx >= 0) providers[idx] = def;
  else providers.push(def);
}

/** 按注册顺序返回第一个「apiKeyEnv 里有非空环境变量」的 provider；都没有则 undefined。 */
export function findFirstConfiguredProvider(): ProviderDefinition | undefined {
  return providers.find((def) => def.apiKeyEnv.some((env) => readEnv(env) !== undefined));
}
