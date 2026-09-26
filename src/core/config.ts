import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config, McpServerConfig, ProviderDefinition } from "./types.js";
import { createLogger } from "@blh/logger";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { readEnv } from "./env.js";
import { getProviderDefinition, findFirstConfiguredProvider } from "../providers/catalog.js";

const log = createLogger("core.config");

/** 配置解析失败。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 从 start 目录开始，一层一层往上找第一个 .env 文件（必须是真实存在的普通文件）；找不到就返回 undefined。 */
function findDotenv(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** 判断某个路径是不是真实存在的普通文件；不存在、或是个目录，都返回 false。 */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 收集指定文件名的配置：先全局 ~/.blh/<name>，再项目 .blh/<name>（从 start 向上找第一个）。 */
function findConfigFiles(start: string, filename: string): string[] {
  const files: string[] = [];
  const user = path.join(os.homedir(), ".blh", filename);
  if (isFile(user)) files.push(user);
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".blh", filename);
    if (isFile(candidate)) {
      files.push(candidate);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

/** 把一个值转成整数；转不了（比如传了 "abc"）就抛错。用来校验配置里的数字项。 */
function toInt(value: unknown, key: string): number {
  let number: number;
  if (typeof value === "number" && Number.isInteger(value)) {
    number = value;
  } else {
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) {
      throw new ConfigError(`${key} 不是合法的整数: ${JSON.stringify(value)}`);
    }
    number = Number.parseInt(text, 10);
  }
  if (number < 0) {
    throw new ConfigError(`${key} 不能为负数: ${JSON.stringify(value)}`);
  }
  return number;
}

/** 解析 mcp.yaml 顶层数组（逐项转 McpServerConfig）。空值返回空数组。 */
function parseMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`mcp.yaml 必须是数组: ${JSON.stringify(value)}`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ConfigError(`mcp.yaml[${index}] 必须是对象`);
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : "";
    if (!name) throw new ConfigError(`mcp.yaml[${index}] 缺少 name`);
    const server: McpServerConfig = { name };
    if (typeof obj.command === "string") server.command = obj.command;
    if (Array.isArray(obj.args)) server.args = obj.args.map((a) => String(a));
    if (typeof obj.url === "string") server.url = obj.url;
    if (obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)) {
      server.headers = Object.fromEntries(
        Object.entries(obj.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
    return server;
  });
}

/** 加载并合并 mcp.yaml（全局 → 项目，按 name 合并，项目覆盖同名）。 */
function loadMcpServers(start: string): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const filePath of findConfigFiles(start, "mcp.yaml")) {
    const data: unknown = parseYaml(readFileSync(filePath, "utf8"));
    if (data === null || data === undefined) continue;
    for (const server of parseMcpServers(data)) merged.set(server.name, server);
  }
  return [...merged.values()];
}

function providerHasKey(def: ProviderDefinition): boolean {
  return def.apiKeyEnv.some((env) => readEnv(env) !== undefined);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 加载最终配置：provider/model 多级解析，配置目录 ~/.blh/ + .blh/，MCP 拆到 mcp.yaml。 */
export function loadConfig(workdir?: string, cli?: Record<string, unknown>): Config {
  const dotenv = findDotenv(process.cwd());
  if (dotenv) {
    loadDotenv({ path: dotenv }); // 已存在的环境变量优先，不覆盖
  }

  const cliValues = cli ?? {};

  const fileValues: Record<string, unknown> = {};
  const configFiles = findConfigFiles(process.cwd(), "config.yaml");
  for (const filePath of configFiles) {
    const data: unknown = parseYaml(readFileSync(filePath, "utf8"));
    if (data === null || data === undefined) continue;
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new ConfigError(`配置文件 ${filePath} 必须是一个键值对映射`);
    }
    Object.assign(fileValues, data);
  }
  log.debug("配置已加载", { files: configFiles });

  const mcpServers = loadMcpServers(process.cwd());

  // provider 解析：CLI > BLH_PROVIDER > file > settings 记忆(有 key) > 自动检测 > deepseek
  const explicitProvider =
    stringOrUndefined(cliValues.provider) ?? readEnv("BLH_PROVIDER") ?? stringOrUndefined(fileValues.provider);
  const settings = loadSettings();
  let providerId = explicitProvider;
  if (!providerId && settings.provider) {
    try {
      if (providerHasKey(getProviderDefinition(settings.provider))) providerId = settings.provider;
    } catch {
      // 记忆的 provider 已不存在，跳过
    }
  }
  if (!providerId) providerId = findFirstConfiguredProvider()?.id;
  if (!providerId) providerId = "deepseek";
  const def = getProviderDefinition(providerId);

  // model 解析：CLI > OPENAI_MODEL > file > settings 记忆(同 provider 时) > defaultModel
  const explicitModel =
    stringOrUndefined(cliValues.model) ?? readEnv("OPENAI_MODEL") ?? stringOrUndefined(fileValues.model);
  let model = explicitModel;
  if (!model && providerId === settings.provider && settings.model) model = settings.model;
  if (!model) model = def.defaultModel;

  // baseUrl 解析：CLI > OPENAI_BASE_URL > file > def.baseUrl
  const baseUrl =
    stringOrUndefined(cliValues.base_url) ?? readEnv("OPENAI_BASE_URL") ?? stringOrUndefined(fileValues.base_url) ?? def.baseUrl;

  // apiKey 只从 file（环境变量 key 交给 createProvider 按 def.apiKeyEnv 解析）
  const apiKey = stringOrUndefined(fileValues.api_key) ?? "";

  // 记忆上次显式选择（至少一项显式才写；换 provider 且无显式 model 时清除旧 model 记忆）
  if (explicitProvider || explicitModel) {
    const nextSettings: Settings = { ...settings };
    if (explicitProvider) {
      nextSettings.provider = explicitProvider;
      if (!explicitModel) delete nextSettings.model;
    }
    if (explicitModel) nextSettings.model = explicitModel;
    saveSettings(nextSettings);
  }

  const workdirValue = String(workdir ?? process.cwd());
  const bashTimeout = toInt(cliValues.bash_timeout ?? readEnv("BLH_BASH_TIMEOUT") ?? fileValues.bash_timeout ?? 120, "bash_timeout");
  const maxOutputChars = toInt(
    cliValues.max_output_chars ?? readEnv("BLH_MAX_OUTPUT_CHARS") ?? fileValues.max_output_chars ?? 30000,
    "max_output_chars",
  );

  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model,
    provider: providerId,
    workdir: workdirValue,
    bashTimeout,
    maxOutputChars,
    mcpServers,
  };
}
