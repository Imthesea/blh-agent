import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config, McpServerConfig, ProviderDefinition } from "../contracts/types.js";
import { createLogger } from "@blh/logger";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { readEnv } from "./env.js";
import { getProviderDefinition, findFirstConfiguredProvider } from "../providers/catalog.js";

const log = createLogger("config.config");

/** 配置加载过程中抛出的错误类型，带自定义 name 方便上层识别与分类。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** loadConfig 的入参。 */
export interface LoadConfigOptions {
  /** 配置发现根目录：.env、config.yaml、mcp.yaml 都从这里向上查找。 */
  configRoot: string;
  /** 运行数据目录（可选），默认等于 configRoot；记忆、任务、日志等运行产物写到这里。 */
  workdir?: string;
  /** 命令行覆盖项（可选），优先级最高。 */
  cli?: Record<string, unknown>;
}

/** 从 start 目录开始向上逐级查找 .env 文件，找到返回其路径，找不到返回 undefined。 */
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

/** 判断给定路径是否是一个存在的普通文件；路径不存在或读取异常时返回 false。 */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 查找指定名字的配置文件，返回按优先级从低到高排序的路径列表：
 * 先收集用户级 ~/.blh/<filename>，再从 start 目录向上找项目级 .blh/<filename>。
 * 调用方遍历时后出现的会覆盖先出现的，因此项目级配置优先级更高。
 */
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

/**
 * 把值安全地转成非负整数，用于校验 bash_timeout、max_output_chars 等整数配置。
 * 值不是合法整数、或为负数时抛 ConfigError，并带上字段名 key 方便定位。
 */
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

/**
 * 校验并转换 mcp.yaml 里的原始数据为 McpServerConfig 列表。
 * 期望是一个对象数组，每个对象至少要有 name；command/args/url/headers 按需透传。
 * 结构不对或缺少 name 时抛 ConfigError。
 */
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
    if (Array.isArray(obj.args)) server.args = obj.args.map((argument) => String(argument));
    if (typeof obj.url === "string") server.url = obj.url;
    if (obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)) {
      server.headers = Object.fromEntries(
        Object.entries(obj.headers as Record<string, unknown>).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
    }
    return server;
  });
}

/**
 * 读取并合并所有 mcp.yaml 配置文件里的 MCP 服务器列表。
 * 同名服务器按 name 去重，后读取的（项目级）覆盖先读取的（用户级）。
 */
function loadMcpServers(start: string): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const filePath of findConfigFiles(start, "mcp.yaml")) {
    const data: unknown = parseYaml(readFileSync(filePath, "utf8"));
    if (data === null || data === undefined) continue;
    for (const server of parseMcpServers(data)) merged.set(server.name, server);
  }
  return [...merged.values()];
}

/** 判断某个 provider 定义所需的 API key 环境变量是否至少有一个已配置。 */
function providerHasKey(def: ProviderDefinition): boolean {
  return def.apiKeyEnv.some((env) => readEnv(env) !== undefined);
}

/** 把值转成「非空字符串或 undefined」，用于过滤空串/非字符串的配置值。 */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 加载完整运行配置并返回 Config。
 *
 * 读取顺序与优先级（越靠前越优先）：
 *   CLI 参数 > 环境变量 > 项目配置文件（config.yaml）> 用户 settings > 内置默认值。
 *
 * 关键语义：
 *   - configRoot：配置发现根目录，.env / .blh/config.yaml / .blh/mcp.yaml 都从这里向上查找；
 *   - workdir：运行数据目录，记忆、任务、日志等运行产物写到这里（默认等于 configRoot）。
 */
export function loadConfig(options: LoadConfigOptions): Config {
  const configRoot = path.resolve(options.configRoot);
  const runtimeWorkdir = path.resolve(options.workdir ?? configRoot);
  const dotenv = findDotenv(configRoot);
  if (dotenv) {
    loadDotenv({ path: dotenv });
  }

  const cliValues = options.cli ?? {};
  const fileValues: Record<string, unknown> = {};
  const configFiles = findConfigFiles(configRoot, "config.yaml");
  for (const filePath of configFiles) {
    const data: unknown = parseYaml(readFileSync(filePath, "utf8"));
    if (data === null || data === undefined) continue;
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new ConfigError(`配置文件 ${filePath} 必须是一个键值对映射`);
    }
    Object.assign(fileValues, data);
  }
  log.debug("配置已加载", { files: configFiles });

  const mcpServers = loadMcpServers(configRoot);
  const explicitProvider =
    stringOrUndefined(cliValues.provider) ??
    readEnv("BLH_PROVIDER") ??
    stringOrUndefined(fileValues.provider);
  const settings = loadSettings();
  let providerId = explicitProvider;
  if (!providerId && settings.provider) {
    try {
      if (providerHasKey(getProviderDefinition(settings.provider))) providerId = settings.provider;
    } catch {
    }
  }
  if (!providerId) providerId = findFirstConfiguredProvider()?.id;
  if (!providerId) providerId = "deepseek";
  const def = getProviderDefinition(providerId);

  const explicitModel =
    stringOrUndefined(cliValues.model) ??
    readEnv("OPENAI_MODEL") ??
    stringOrUndefined(fileValues.model);
  let model = explicitModel;
  if (!model && providerId === settings.provider && settings.model) model = settings.model;
  if (!model) model = def.defaultModel;

  const baseUrl =
    stringOrUndefined(cliValues.base_url) ??
    readEnv("OPENAI_BASE_URL") ??
    stringOrUndefined(fileValues.base_url) ??
    def.baseUrl;
  const apiKey = stringOrUndefined(fileValues.api_key) ?? "";

  if (explicitProvider || explicitModel) {
    const nextSettings: Settings = { ...settings };
    if (explicitProvider) {
      nextSettings.provider = explicitProvider;
      if (!explicitModel) delete nextSettings.model;
    }
    if (explicitModel) nextSettings.model = explicitModel;
    saveSettings(nextSettings);
  }

  const bashTimeout = toInt(
    cliValues.bash_timeout ??
      readEnv("BLH_BASH_TIMEOUT") ??
      fileValues.bash_timeout ??
      120,
    "bash_timeout",
  );
  const maxOutputChars = toInt(
    cliValues.max_output_chars ??
      readEnv("BLH_MAX_OUTPUT_CHARS") ??
      fileValues.max_output_chars ??
      30000,
    "max_output_chars",
  );

  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model,
    provider: providerId,
    workdir: runtimeWorkdir,
    bashTimeout,
    maxOutputChars,
    mcpServers,
  };
}
