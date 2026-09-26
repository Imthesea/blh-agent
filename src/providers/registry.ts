import type { ChatProvider, Config, ProviderDefinition } from "../core/types.js";
import { getProviderDefinition } from "./catalog.js";
import { readEnv } from "../core/env.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { AnthropicProvider } from "./anthropic.js";

/** 解析最终 apiKey：配置文件 api_key 优先，否则按 def.apiKeyEnv 顺序读环境变量；都没有则空串。 */
export function resolveApiKey(config: Config, def: ProviderDefinition): string {
  if (config.apiKey) return config.apiKey;
  for (const env of def.apiKeyEnv) {
    const value = readEnv(env);
    if (value !== undefined) return value;
  }
  return "";
}

/** 根据 config.provider 创建对应 ChatProvider（未指定时兜底 deepseek）。 */
export function createProvider(config: Config): ChatProvider {
  const def = getProviderDefinition(config.provider ?? "deepseek");
  const apiKey = resolveApiKey(config, def);
  if (!apiKey) {
    const names = def.apiKeyEnv.join(" / ");
    throw new Error(`未设置 ${def.name} 的 API key：请设置环境变量 ${names}，或在配置文件里填 api_key`);
  }
  const resolved: Config = {
    ...config,
    provider: def.id,
    apiKey,
    baseUrl: config.baseUrl ?? def.baseUrl,
  };
  return def.api === "anthropic" ? new AnthropicProvider(resolved) : new OpenAICompatProvider(resolved);
}
