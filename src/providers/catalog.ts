import type { ProviderDefinition, ProviderId } from "../core/types.js";
import { readEnv } from "../core/env.js";

/** 内置 provider 描述表。catalog 顺序 = 自动检测优先级（deepseek 第一保证老用户升级不变）。 */
const builtin: ProviderDefinition[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"],
    defaultModel: "deepseek-chat",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "qwen",
    name: "Qwen",
    api: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY"],
    defaultModel: "qwen-max",
  },
  {
    id: "kimi",
    name: "Kimi",
    api: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    defaultModel: "moonshot-v1-8k",
  },
];

const providers: ProviderDefinition[] = [...builtin];

export function getProviderDefinition(id: string): ProviderDefinition {
  const def = providers.find((d) => d.id === id);
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
