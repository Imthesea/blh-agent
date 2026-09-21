import { PassThrough } from "node:stream";
import readline from "node:readline";
import { describe, it, expect, vi } from "vitest";
import { createLogger } from "@blh/logger";
import { repl, makeReadlineIO } from "../../src/cli/repl.js";
import { Harness } from "../../src/core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltinTools } from "../../src/tools/index.js";
import { makePermissionHook, type ApprovalAsker, type ApprovalDecision } from "../../src/security/approval.js";
import { DEFAULT_RULES } from "../../src/security/rules.js";
import {
  MockProvider,
  makeTextMessage,
  makeToolCallMessage,
} from "../integration/helpers.js";
import type { Config } from "../../src/core/types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: ".",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function askUser(rl: readline.Interface): ApprovalAsker {
  return (req) =>
    new Promise<ApprovalDecision>((resolve) => {
      rl.question(`allow ${req.tool}(${req.target})? [y/N] `, (answer) => {
        const a = answer.trim().toLowerCase();
        resolve(a === "y" || a === "yes" ? "allow" : "deny");
      });
    });
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("repl readline 复用", () => {
  it("权限询问复用同一 readline 接口,询问后仍可继续输入", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const rl = readline.createInterface({ input: stdin, output: stdout });

    const provider = new MockProvider([
      makeToolCallMessage("bash", { command: "echo hi" }),
      makeTextMessage("done"),
    ]);
    const tools = new ToolRegistry();
    registerBuiltinTools(tools, config);
    const hooks = new HookBus();
    hooks.register(PRE_TOOL_USE, (payload) =>
      makePermissionHook(DEFAULT_RULES, askUser(rl))(payload.name, payload.input),
    );
    const harness = new Harness(config, provider, tools, hooks);

    const printed: string[] = [];
    const base = makeReadlineIO(rl);
    const done = repl(harness, {
      readLine: base.readLine,
      print: (text: string) => {
        printed.push(text);
      },
      write: () => {},
    });

    // 收集 readline 写出的提示,按提示逐步喂入(模拟真实用户在提示后输入)
    let out = "";
    stdout.on("data", (chunk) => {
      out += chunk.toString();
    });

    await waitFor(() => out.includes("> "));
    stdin.write("run echo\n");

    await waitFor(() => out.includes("allow bash(echo hi)? [y/N] "));
    stdin.write("y\n");

    await waitFor(() => (out.match(/> /g) ?? []).length >= 2);
    stdin.write("exit\n");

    await done;
    stdin.end();
    rl.close();

    expect(printed).toContain("done");
  });
});

describe("makeReadlineIO.write", () => {
  it("原始输出不带换行", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const io = makeReadlineIO(rl);
      io.write("hel");
      expect(write).toHaveBeenCalledWith("hel");
      rl.close();
    } finally {
      write.mockRestore();
    }
  });
});

describe("makeReadlineIO 日志清行重绘", () => {
  it("等待输入时后台日志走清行重绘,不直接写 stderr 覆盖提示符", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const rl = readline.createInterface({ input: stdin, output: stdout });

    const clearLine = vi.spyOn(readline, "clearLine").mockImplementation(() => true);
    const cursorTo = vi.spyOn(readline, "cursorTo").mockImplementation(() => true);
    const prompt = vi.spyOn(rl, "prompt").mockImplementation(() => {});
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const io = makeReadlineIO(rl);
    try {
      // 挂起一次输入,使 awaitingInput 为 true
      const pending = io.readLine();
      // 等待输入期间打一条后台日志(模拟 MCP 连接完成这类异步日志)
      createLogger("test").info("后台日志");

      expect(clearLine).toHaveBeenCalled();
      expect(cursorTo).toHaveBeenCalled();
      expect(prompt).toHaveBeenCalled();
      expect(stdoutWrite).toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();

      // 结束挂起,避免遗留未 resolve 的 Promise
      stdin.write("x\n");
      await pending;
    } finally {
      clearLine.mockRestore();
      cursorTo.mockRestore();
      prompt.mockRestore();
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      rl.close();
    }
  });
});
