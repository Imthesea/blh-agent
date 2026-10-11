import { exec } from "node:child_process";
import readline from "node:readline";
import * as path from "node:path";
import { repl, makeReadlineIO } from "./repl.js";
import { SessionStore } from "../session/store.js";
import type { Transcript } from "../session/transcript.js";
import { createLogger } from "@blh/logger";
import type { ApprovalAsker, ApprovalDecision } from "../security/approval.js";
import { startWebServerFromCli } from "./web.js";
import { buildHarness } from "./buildHarness.js";
import { parseCliArgs, USAGE, type ParsedCliArgs } from "./args.js";

export const log = createLogger("cli");

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

/** 程序入口：解析参数，然后按三种模式之一执行——web 工作台、一次性 prompt、交互式 REPL。 */
export async function main(args: string[]): Promise<void> {
  // 解析命令行参数。其中 continue 是 JS 保留字不能直接当变量名，所以重命名成 doContinue。
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`参数错误: ${message}`);
    console.error("用法: blh --help");
    process.exitCode = 1;
    return;
  }
  const {
    prompt,
    workdir,
    cli,
    help,
    skipPermissions,
    continue: doContinue,
    continueFile,
    web,
    port,
    dev,
  } = parsed;

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
    let closing = false;
    const closeForSignal = () => {
      if (closing) return;
      closing = true;
      void server
        .close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          log.error("web 服务器关闭失败", {}, error);
          process.exit(1);
        });
    };
    process.once("SIGINT", closeForSignal);
    process.once("SIGTERM", closeForSignal);
    return;
  }

  // —— 一次性模式：blh -p "提示词"，跑一轮就打印结果退出。
  if (prompt !== undefined) {
    // 空提示词没有意义，报错退出。
    if (!prompt) {
      log.error("用法: blh -p <文本>");
      process.exitCode = 1;
      return;
    }
    // 组装 harness；第三个参数 askUser 传 undefined，因为一次性模式不需要交互审批弹窗。
    const harness = buildHarness(workdir, cli, undefined, skipPermissions);
    // 打印启动信息：工作目录 + 模型名。
    log.info("启动", { workdir: harness.config.workdir, model: harness.config.model });
    // 新建一个只含 system 消息的会话。
    const transcript = harness.newTranscript();
    try {
      // 把用户提示词当一轮输入跑一遍（内部会反复调用模型直到不再要工具）。
      await harness.runTurn(transcript, prompt);
      // 打印最后一条 assistant 回复。
      console.log(transcript.lastAssistantTextAfter(0));
    } finally {
      await harness.dispose();
    }
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

  try {
    let transcript: Transcript;
    if (doContinue) {
      // 继续旧会话：--continue 给了文件名就用它，否则找最近一次存档的会话。
      const file = continueFile
        ? path.join(harness.config.workdir, ".sessions", continueFile)
        : SessionStore.latest(harness.config.workdir);
      // 没找到可继续的会话，报错退出。
      if (!file) throw new Error("没有找到可继续的会话");
      // 打开这个存档文件，后续新消息会往里追加。
      harness.sessionStore = SessionStore.open(file);
      // 从事件日志重放会话；system 由 Harness 重建，不重复落盘。
      transcript = harness.newTranscript(SessionStore.loadSession(file).events);
    } else {
      // 全新会话：在 .sessions/ 下新建存档文件，再建一个只含 system 消息的会话。
      harness.sessionStore = SessionStore.create(harness.config.workdir);
      transcript = harness.newTranscript();
    }
    // 进入交互循环：不断读用户输入、跑 agent、打印结果，直到用户退出。
    await repl(harness, makeReadlineIO(rl), transcript);
  } finally {
    rl.close();
    await harness.dispose();
  }
}
