import { parseArgs } from "node:util";

/** 命令行参数错误：解析失败时抛出，由入口统一转成友好提示并退出。 */
export class CliArgsError extends Error {}

/** 结构化后的命令行参数。 */
export interface ParsedCliArgs {
  prompt?: string;
  workdir?: string;
  help?: boolean;
  skipPermissions?: boolean;
  continue?: boolean;
  continueFile?: string;
  web?: boolean;
  port?: number;
  dev?: boolean;
  cli: Record<string, string>;
}

/** 从命令行参数里取一个字符串值；取不到就返回 undefined。 */
function stringValue(
  values: Record<string, string | boolean | undefined>,
  key: string,
): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function isSessionFileName(file: string): boolean {
  return file !== "" && file !== "." && file !== ".." && !/[\\/]/.test(file);
}

/**
 * 手动扫描 --continue 参数（它是可选值，标准解析不好处理）。
 * 返回是否继续、继续哪个会话文件，以及剔除 --continue 后剩下的参数（供严格解析使用）。
 */
function parseContinue(
  argv: string[],
): { continue?: boolean; continueFile?: string; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--continue") continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      if (!isSessionFileName(next)) throw new CliArgsError(`invalid session file: ${next}`);
      return {
        continue: true,
        continueFile: next,
        rest: [...argv.slice(0, i), ...argv.slice(i + 2)],
      };
    }
    return { continue: true, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { rest: argv };
}

/** 用法说明。 */
export const USAGE = `用法: blh [-h] [-p 提示词] [--provider 厂商] [--model 模型] [--base-url 基础地址]
            [--workdir 工作目录] [--bash-timeout 超时秒数]
            [--max-output-chars 最大输出字符数]
            [--dangerously-skip-permissions]

编程智能体命令行工具 (TypeScript)

选项:
  --provider 厂商         provider id（deepseek/anthropic/qwen/kimi；默认 deepseek）
  -p, --print 提示词      跑一次单个提示词并打印回复
  --model 模型            模型名（覆盖 OPENAI_MODEL）
  --base-url 基础地址     OpenAI 兼容的基础地址（覆盖 OPENAI_BASE_URL）
  --workdir 工作目录       运行工作目录（不改变配置发现目录）
  --bash-timeout N        bash 超时秒数
  --max-output-chars N    最大捕获输出字符数
  --dangerously-skip-permissions
                          允许所有 bash 命令，除了硬性禁止规则
  --sandbox-mode MODE     文件边界：full（默认，不限制）| workspace（限制在 sandbox-root 内）
  --sandbox-root 目录     workspace 模式的可写根目录（默认 workdir）
  --continue [文件]       继续之前的会话（最近一次，或 .sessions/ 里的文件）
  blh web [--port N] [--dev] [--workdir 目录]
                          启动 web 交互式工作台（端口优先级：--port、BLH_WEB_PORT、8123）
  -h, --help              显示帮助信息并退出`;

/** 解析命令行参数，拼成结构化结果：一次性 prompt、工作目录、模型等配置，以及是否跳过权限。 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  // 先剥离 --continue（可选值），再用严格模式解析其余参数：
  // 未知参数、缺少参数值（如 -p 不带值）都会抛错，而不是被静默忽略。
  const continued = parseContinue(argv);
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: continued.rest,
      options: {
        help: { type: "boolean", short: "h" },
        print: { type: "string", short: "p" },
        model: { type: "string" },
        "base-url": { type: "string" },
        provider: { type: "string" },
        workdir: { type: "string" },
        "bash-timeout": { type: "string" },
        "max-output-chars": { type: "string" },
        "dangerously-skip-permissions": { type: "boolean" },
        port: { type: "string" },
        "sandbox-mode": { type: "string" },
        "sandbox-root": { type: "string" },
        dev: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new CliArgsError(error instanceof Error ? error.message : String(error));
  }

  const model = stringValue(values, "model");
  const baseUrl = stringValue(values, "base-url");
  const provider = stringValue(values, "provider");
  const bashTimeout = stringValue(values, "bash-timeout");
  const maxOutputChars = stringValue(values, "max-output-chars");
  const sandboxMode = stringValue(values, "sandbox-mode");
  const sandboxRoot = stringValue(values, "sandbox-root");
  const workdirValue = stringValue(values, "workdir");
  const prompt = stringValue(values, "print");
  const help = values.help === true;
  const skipPermissions = values["dangerously-skip-permissions"] === true;

  const web = positionals[0] === "web";
  const portValue = stringValue(values, "port");
  const port =
    portValue !== undefined && /^\d+$/.test(portValue) ? Number.parseInt(portValue, 10) : undefined;
  const dev = values.dev === true;

  const cli: Record<string, string> = {};
  if (model !== undefined) cli.model = model;
  if (baseUrl !== undefined) cli.base_url = baseUrl;
  if (provider !== undefined) cli.provider = provider;
  if (bashTimeout !== undefined) cli.bash_timeout = bashTimeout;
  if (maxOutputChars !== undefined) cli.max_output_chars = maxOutputChars;
  if (sandboxMode !== undefined) cli.sandbox_mode = sandboxMode;
  if (sandboxRoot !== undefined) cli.sandbox_root = sandboxRoot;
  if (workdirValue !== undefined) cli.workdir = workdirValue;

  return {
    ...(help ? { help } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(workdirValue !== undefined ? { workdir: workdirValue } : {}),
    ...(skipPermissions ? { skipPermissions } : {}),
    ...(continued.continue ? { continue: true } : {}),
    ...(continued.continueFile !== undefined ? { continueFile: continued.continueFile } : {}),
    ...(web ? { web: true } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(dev ? { dev: true } : {}),
    cli,
  };
}
