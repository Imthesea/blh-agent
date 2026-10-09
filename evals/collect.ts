import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isDestructiveBashCommand } from "../src/security/rules.js";
import type { ChatMessage } from "../src/contracts/types.js";
import type { Transcript } from "../src/session/transcript.js";
import type { CaseContext, EvalCase, ToolCallRecord } from "./check.js";

/** 解析工具调用的 JSON 参数；解析失败时返回空对象，避免脏数据打断整段跑分。 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 从 transcript 抽取 lead 的工具调用序列。 */
export function collectToolCalls(messages: readonly ChatMessage[]): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || message.tool_calls === undefined) continue;
    for (const call of message.tool_calls) {
      out.push({ name: call.function.name, args: parseToolArguments(call.function.arguments) });
    }
  }
  return out;
}

/** 对 bash 工具调用做危险命令扫描，返回命中的命令列表。 */
export function collectSafetyViolations(toolCalls: readonly ToolCallRecord[]): string[] {
  const violations: string[] = [];
  for (const call of toolCalls) {
    if (call.name !== "bash") continue;
    const command = typeof call.args.command === "string" ? call.args.command : "";
    if (isDestructiveBashCommand(command)) violations.push(command);
  }
  return violations;
}

/** 读取用例声明要检查的文件；文件不存在时留空，交给 checkCase 报「未落地」。 */
export async function collectFiles(workdir: string, evalCase: EvalCase): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of evalCase.expect_files ?? []) {
    const full = path.join(workdir, file.path);
    try {
      files.set(file.path, await fs.readFile(full, "utf8"));
    } catch {
      // 未落地
    }
  }
  return files;
}

/** 在 workdir 里执行 verify 命令，退出码 0 = 通过。跨平台：Windows 走 cmd，POSIX 走 sh。 */
export function runVerify(workdir: string, command: string): boolean {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const result = spawnSync(shell, shellArgs, { cwd: workdir, stdio: "ignore" });
  return result.status === 0;
}

/** 收集一次跑分后的完整「上下文快照」，供 checkCase / judge 使用。 */
export async function collectContext(
  transcript: Transcript,
  workdir: string,
  evalCase: EvalCase,
  tasksCompleted = 0,
): Promise<CaseContext> {
  const toolCalls = collectToolCalls(transcript.messages);
  const context: CaseContext = {
    toolCalls,
    tasksCompleted,
    files: await collectFiles(workdir, evalCase),
    finalOutput: transcript.lastAssistantTextAfter(0),
    safetyViolations: collectSafetyViolations(toolCalls),
  };
  if (evalCase.verify !== undefined) {
    context.verifyPassed = runVerify(workdir, evalCase.verify);
  }
  return context;
}