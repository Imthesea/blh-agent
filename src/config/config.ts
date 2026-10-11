import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config, McpServerConfig, ProviderDefinition } from "../contracts/types.js";
import { Diagnostics } from "../contracts/diagnostics.js";
import { createLogger } from "@blh/logger";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { readEnv } from "./env.js";
import { findFirstConfiguredProvider, findProviderDefinition, listProviders } from "../providers/catalog.js";

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
 * 值不是合法整数、或为负数时记录一条 error 诊断并回退 fallback，不再抛错，
 * 这样多个字段的非法值可以在一次启动里全部列出来。
 */
function toInt(value: unknown, key: string, fallback: number, diagnostics: Diagnostics): number {
  let number: number;
  if (typeof value === "number" && Number.isInteger(value)) {
    number = value;
  } else {
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) {
      diagnostics.push({ type: "error", message: `${key} 不是合法的整数: ${JSON.stringify(value)}`, path: key });
      return fallback;
    }
    number = Number.parseInt(text, 10);
  }
  if (number < 0) {
    diagnostics.push({ type: "error", message: `${key} 不能为负数: ${JSON.stringify(value)}`, path: key });
    return fallback;
  }
  return number;
}

/**
 * 校验并转换 mcp.yaml 里的原始数据为 McpServerConfig 列表。
 * 期望是一个对象数组，每个对象至少要有 name；command/args/url/headers 按需透传。
 * 结构不对或缺少 name 时记录 error 诊断并跳过该项，其余项继续解析。
 */
function parseMcpServers(value: unknown, diagnostics: Diagnostics): McpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push({ type: "error", message: `mcp.yaml 必须是数组: ${JSON.stringify(value)}`, path: "mcp.yaml" });
    return [];
  }
  const servers: McpServerConfig[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      diagnostics.push({ type: "error", message: `mcp.yaml[${index}] 必须是对象`, path: "mcp.yaml" });
      return;
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : "";
    if (!name) {
      diagnostics.push({ type: "error", message: `mcp.yaml[${index}] 缺少 name`, path: "mcp.yaml" });
      return;
    }
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
    servers.push(server);
  });
  return servers;
}

/**
 * 读取并合并所有 mcp.yaml 配置文件里的 MCP 服务器列表。
 * 同名服务器按 name 去重，后读取的（项目级）覆盖先读取的（用户级）。
 * 文件解析失败记录 error 诊断并跳过该文件。
 */
function loadMcpServers(start: string, diagnostics: Diagnostics): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const filePath of findConfigFiles(start, "mcp.yaml")) {
    let data: unknown;
    try {
      data = parseYaml(readFileSync(filePath, "utf8"));
    } catch (error) {
      diagnostics.push({
        type: "error",
        message: `无法解析 ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        path: filePath,
      });
      continue;
    }
    if (data === null || data === undefined) continue;
    for (const server of parseMcpServers(data, diagnostics)) merged.set(server.name, server);
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
 *
 * 诊断语义：
 *   - 传入 diagnostics 时：所有问题聚合进收集器，函数返回带兜底值的 Config，不抛错；由调用方决定是否阻断。
 *   - 不传 diagnostics 时（向后兼容）：仍以抛 ConfigError 的方式阻断，并把全部 error 聚合进一条消息。
 */
export function loadConfig(options: LoadConfigOptions, externalDiagnostics?: Diagnostics): Config {
  const diagnostics = externalDiagnostics ?? new Diagnostics();
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
    let data: unknown;
    try {
      data = parseYaml(readFileSync(filePath, "utf8"));
    } catch (error) {
      diagnostics.push({
        type: "error",
        message: `无法解析 ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        path: filePath,
      });
      continue;
    }
    if (data === null || data === undefined) continue;
    if (typeof data !== "object" || Array.isArray(data)) {
      diagnostics.push({ type: "error", message: `配置文件 ${filePath} 必须是一个键值对映射`, path: filePath });
      continue;
    }
    Object.assign(fileValues, data);
  }
  log.debug("配置已加载", { files: configFiles });

  const mcpServers = loadMcpServers(configRoot, diagnostics);
  const explicitProvider =
    stringOrUndefined(cliValues.provider) ??
    readEnv("BLH_PROVIDER") ??
    stringOrUndefined(fileValues.provider);
  const settings = loadSettings();
  let providerId = explicitProvider;
  if (!providerId && settings.provider) {
    const settingsDef = findProviderDefinition(settings.provider);
    if (settingsDef) {
      if (providerHasKey(settingsDef)) providerId = settings.provider;
    } else {
      diagnostics.push({
        type: "warning",
        message: `settings 里的 provider '${settings.provider}' 未知，已忽略`,
        path: "provider",
      });
    }
  }
  if (!providerId) providerId = findFirstConfiguredProvider()?.id;
  if (!providerId) providerId = "deepseek";

  let def = findProviderDefinition(providerId);
  if (!def) {
    diagnostics.push({
      type: "error",
      message: `未知 provider '${providerId}'（可用：${listProviders().join(", ")}）`,
      path: "provider",
    });
    // 用兜底 provider 继续加载其余字段，保证一次启动能收集齐所有错误。
    def = findProviderDefinition("deepseek")!;
    providerId = "deepseek";
  }

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
    if (explicitProvider && findProviderDefinition(explicitProvider)) {
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
    120,
    diagnostics,
  );
  const maxOutputChars = toInt(
    cliValues.max_output_chars ??
      readEnv("BLH_MAX_OUTPUT_CHARS") ??
      fileValues.max_output_chars ??
      30000,
    "max_output_chars",
    30000,
    diagnostics,
  );

  const rawSandboxMode =
    stringOrUndefined(cliValues.sandbox_mode) ??
    readEnv("BLH_SANDBOX_MODE") ??
    stringOrUndefined(fileValues.sandbox_mode) ??
    "full";
  const sandboxMode: "full" | "workspace" =
    rawSandboxMode === "workspace" ? "workspace" : "full";
  if (rawSandboxMode !== "full" && rawSandboxMode !== "workspace") {
    diagnostics.push({
      type: "warning",
      message: `未知 sandbox_mode '${rawSandboxMode}'，已回退 full`,
      path: "sandbox_mode",
    });
  }
  const sandboxRoot =
    stringOrUndefined(cliValues.sandbox_root) ??
    readEnv("BLH_SANDBOX_ROOT") ??
    stringOrUndefined(fileValues.sandbox_root) ??
    runtimeWorkdir;
  const config: Config = {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model,
    provider: providerId,
    workdir: runtimeWorkdir,
    bashTimeout,
    maxOutputChars,
    mcpServers,
    sandboxMode,
    sandboxRoot,
  };

  // 向后兼容：未显式传入收集器时，仍以抛错方式阻断，并聚合全部错误。
  if (externalDiagnostics === undefined && diagnostics.hasErrors()) {
    throw new ConfigError(diagnostics.errors().map((item) => item.message).join("; "));
  }

  return config;
}