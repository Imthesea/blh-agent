import type { ChatProvider, Config, ProviderDefinition } from "../contracts/types.js";
import { Diagnostics } from "../contracts/diagnostics.js";
import { findProviderDefinition, listProviders } from "./catalog.js";
import { readEnv } from "../config/env.js";
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

/**
 * 根据 config.provider 创建对应 ChatProvider（未指定时兜底 deepseek）。
 *
 * 诊断语义：
 *   - 不传 diagnostics：保持旧的抛错行为（未知 provider / 缺 key 都直接 throw）。
 *   - 传入 diagnostics：
 *       - 未知 provider：记录 error 诊断后仍 throw（无法构造出可用 provider）；
 *       - 缺 API key：记录 error 诊断后返回一个带空 key 的 provider，由调用方汇总后统一阻断。
 */
export function createProvider(config: Config, diagnostics?: Diagnostics): ChatProvider {
  const def = findProviderDefinition(config.provider ?? "deepseek");
  if (!def) {
    const message = `未知 provider '${config.provider}'（可用：${listProviders().join(", ")}）`;
    diagnostics?.push({ type: "error", message, path: "provider" });
    throw new Error(message);
  }
  const apiKey = resolveApiKey(config, def);
  if (!apiKey) {
    const names = def.apiKeyEnv.join(" / ");
    const message = `未设置 ${def.name} 的 API key：请设置环境变量 ${names}，或在配置文件里填 api_key`;
    if (diagnostics === undefined) {
      throw new Error(message);
    }
    diagnostics.push({ type: "error", message, path: "provider" });
  }
  const resolved: Config = {
    ...config,
    provider: def.id,
    apiKey,
    baseUrl: config.baseUrl ?? def.baseUrl,
  };
  return def.api === "anthropic" ? new AnthropicProvider(resolved) : new OpenAICompatProvider(resolved);
}