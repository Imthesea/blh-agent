#!/usr/bin/env node
import { exec } from "node:child_process";
import readline from "node:readline";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { lastAssistantText } from "../core/loop.js";
import { repl, makeReadlineIO } from "./repl.js";
import type { ChatMessage } from "../core/types.js";
import { SessionStore } from "../session/store.js";
import { createLogger } from "@blh/logger";
import type { ApprovalAsker, ApprovalDecision } from "../security/approval.js";
import { startWebServerFromCli } from "./web.js";
import { buildHarness } from "./buildHarness.js";

export { buildHarness };

export const log = createLogger("cli");

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

/** 手动扫描 --continue 参数（它是可选值，标准解析不好处理），返回是否继续以及继续哪个会话文件。 */
function parseContinue(argv: string[]): { continue?: boolean; continueFile?: string } {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--continue") continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      return { continue: true, continueFile: next };
    }
    return { continue: true };
  }
  return {};
}

/** 解析命令行参数，拼成结构化结果：一次性 prompt、工作目录、模型等配置，以及是否跳过权限。 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      print: { type: "string", short: "p" },
      model: { type: "string" },
      "base-url": { type: "string" },
      workdir: { type: "string" },
      "bash-timeout": { type: "string" },
      "max-output-chars": { type: "string" },
      "dangerously-skip-permissions": { type: "boolean" },
      port: { type: "string" },
      dev: { type: "boolean" },
    },
    strict: false,
  });

  const model = stringValue(values, "model");
  const baseUrl = stringValue(values, "base-url");
  const bashTimeout = stringValue(values, "bash-timeout");
  const maxOutputChars = stringValue(values, "max-output-chars");
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
  if (bashTimeout !== undefined) cli.bash_timeout = bashTimeout;
  if (maxOutputChars !== undefined) cli.max_output_chars = maxOutputChars;
  if (workdirValue !== undefined) cli.workdir = workdirValue;

  return {
    ...(help ? { help } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(workdirValue !== undefined ? { workdir: workdirValue } : {}),
    ...(skipPermissions ? { skipPermissions } : {}),
    ...parseContinue(argv),
    ...(web ? { web: true } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(dev ? { dev: true } : {}),
    cli,
  };
}

/** 造一个"问用户是否同意"的函数：弹出问题，等用户在终端里输入答案。 */
function makeAskUser(rl: readline.Interface): ApprovalAsker {
  return (req) =>
    new Promise<ApprovalDecision>((resolve) => {
      rl.question(`allow ${req.tool}(${req.target})? [y/N] `, (answer) => {
        const a = answer.trim().toLowerCase();
        resolve(a === "y" || a === "yes" ? "allow" : "deny");
      });
    });
}

/**
 * 「blh web」启动工作台后的收尾动作：本地服务器起来后，直接帮用户把系统默认浏览器
 * 弹到工作台页面，省去用户手动复制粘贴网址这一步。
 * 因为 Windows / macOS / Linux 打开浏览器的命令各不相同，所以这里按平台各写一个命令。
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {});
}

const USAGE = `用法: blh [-h] [-p 提示词] [--model 模型] [--base-url 基础地址]
            [--workdir 工作目录] [--bash-timeout 超时秒数]
            [--max-output-chars 最大输出字符数]
            [--dangerously-skip-permissions]

编程智能体命令行工具 (TypeScript)

选项:
  -p, --print 提示词      跑一次单个提示词并打印回复
  --model 模型            模型名（覆盖 OPENAI_MODEL）
  --base-url 基础地址     OpenAI 兼容的基础地址（覆盖 OPENAI_BASE_URL）
  --workdir 工作目录       工作目录
  --bash-timeout N        bash 超时秒数
  --max-output-chars N    最大捕获输出字符数
  --dangerously-skip-permissions
                          允许所有 bash 命令，除了硬性禁止规则
  --continue [文件]       继续之前的会话（最近一次，或 .sessions/ 里的文件）
  blh web [--port N] [--dev] [--workdir 目录]
                          启动 web 交互式工作台（默认 http://127.0.0.1:8123）
  -h, --help              显示帮助信息并退出`;

/** 程序入口：解析参数，然后按三种模式之一执行——web 工作台、一次性 prompt、交互式 REPL。 */
async function main(): Promise<void> {
  // 解析命令行参数。process.argv 前两项是 node 路径和脚本路径，slice(2) 只取真正的用户参数。
  // 解构出各配置；其中 continue 是 JS 保留字不能直接当变量名，所以重命名成 doContinue。
  const { prompt, workdir, cli, help, skipPermissions, continue: doContinue, continueFile, web, port, dev } =
    parseCliArgs(process.argv.slice(2));

  // —— 帮助模式：用户要 -h/--help，打印用法说明后直接退出。
  if (help) {
    console.log(USAGE);
    return;
  }

  // —— web 模式：blh web，启动本地 web 工作台。
  if (web) {
    // 启动 web 服务器。只有用户显式传了的选项才塞进去（展开运算符 + undefined 判断）。
    const server = await startWebServerFromCli({
      ...(workdir !== undefined ? { workdir } : {}),
      cli,
      ...(port !== undefined ? { port } : {}),
      ...(dev !== undefined ? { dev } : {}),
      ...(skipPermissions !== undefined ? { skipPermissions } : {}),
    });
    // 打印后端实际监听地址。
    log.info("web 服务器已启动", { url: server.url });
    // 生产模式（非 dev）后端自己 serve 前端页面，自动打开浏览器；
    // dev 模式下页面由 Vite dev server 提供，这里不弹，交给 Vite 启动时自己打开。
    if (!dev) {
      openBrowser(server.url);
    }
    return;
  }

  // —— 一次性模式：blh -p "提示词"，跑一轮就打印结果退出。
  if (prompt !== undefined) {
    // 空提示词没有意义，报错退出。
    if (!prompt) {
      log.error("用法: blh -p <文本>");
      process.exit(1);
    }
    // 组装 harness；第三个参数 askUser 传 undefined，因为一次性模式不需要交互审批弹窗。
    const harness = buildHarness(workdir, cli, undefined, skipPermissions);
    // 打印启动信息：工作目录 + 模型名。
    log.info("启动", { workdir: harness.config.workdir, model: harness.config.model });
    // 新建一个只含 system 消息的会话。
    const messages = harness.newSession();
    // 把用户提示词当一轮输入跑一遍（内部会反复调用模型直到不再要工具）。
    await harness.runTurn(messages, prompt);
    // 打印最后一条 assistant 回复。
    console.log(lastAssistantText(messages));
    return;
  }

  // —— 交互 REPL 模式（默认）：进入循环，边问边答。
  // 创建终端读写接口：从键盘读输入、往屏幕写输出。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // 组装 harness；这里传 makeAskUser(rl)，让权限审批弹到终端问用户同意与否。
  const harness = buildHarness(workdir, cli, makeAskUser(rl), skipPermissions);
  log.info("启动 REPL", { workdir: harness.config.workdir, model: harness.config.model });

  let messages: ChatMessage[];
  if (doContinue) {
    // 继续旧会话：--continue 给了文件名就用它，否则找最近一次存档的会话。
    const file = continueFile
      ? path.join(harness.config.workdir, ".sessions", continueFile)
      : SessionStore.latest(harness.config.workdir);
    // 没找到可继续的会话，报错退出。
    if (!file) {
      log.error("没有找到可继续的会话");
      process.exit(1);
    }
    // 打开这个存档文件，后续新消息会往里追加。
    harness.sessionStore = SessionStore.open(file);
    // 先建 system 消息，再把历史消息一条条塞回来。
    messages = harness.newSession();
    messages.push(...SessionStore.load(file));
  } else {
    // 全新会话：在 .sessions/ 下新建存档文件，再建一个只含 system 消息的会话。
    harness.sessionStore = SessionStore.create(harness.config.workdir);
    messages = harness.newSession();
  }
  // 进入交互循环：不断读用户输入、跑 agent、打印结果，直到用户退出。
  await repl(harness, makeReadlineIO(rl), messages);
}

/** 判断这个文件是不是被直接运行（比如 node main.js），而不是被别的文件 import。
 *  只有直接运行时才调用 main()，避免被测试或其它模块 import 时也自动启动程序。 */
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    log.error("致命错误", {}, error);
    process.exit(1);
  });
}
