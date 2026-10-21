/** 后台任务:慢 bash 命令异步执行,后续轮次收集完成通知。 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  BoundedOutputCollector,
  formatTruncatedOutput,
  validateTimeoutSeconds,
} from "../process/output.js";
import { terminateProcessTree } from "../process/terminate.js";
import { TOOL_ERROR_PREFIX } from "@blh/web-protocol";

export interface BackgroundTask {
  command: string;
  status: string;
}

/** 独立实现(蓝本决策:不复用 runBash,它丢弃 exit code)。输出格式与 bash.ts 不同:stdout+stderr 直接拼接。 */
function runBashProcess(
  command: string,
  workdir: string,
  timeout: number,
  maxOutput: number,
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number | null; cancelled: boolean }> {
  validateTimeoutSeconds(timeout, "background timeout");
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    const stdout = new BoundedOutputCollector(maxOutput);
    const stderr = new BoundedOutputCollector(maxOutput);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let termination: { output: string; exitCode: number | null; cancelled: boolean } | undefined;

    const finish = (
      output: string,
      exitCode: number | null,
      cancelled = false,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ output, exitCode, cancelled });
    };

    const terminate = (
      output: string,
      exitCode: number | null,
      cancelled: boolean,
      child?: ChildProcess,
    ): void => {
      if (settled) return;
      termination = { output, exitCode, cancelled };
      cleanup();
      const terminated =
        child === undefined ? Promise.resolve() : terminateProcessTree(child);
      void terminated.then(() => finish(output, exitCode, cancelled));
    };

    if (signal?.aborted) {
      terminate(`${TOOL_ERROR_PREFIX} command cancelled`, null, true);
      return;
    }

    const child = spawn(shell, shellArgs, {
      cwd: workdir,
      detached: process.platform !== "win32",
    });

    const onAbort = () => terminate(`${TOOL_ERROR_PREFIX} command cancelled`, null, true, child);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

    child.on("error", (error) => {
      finish(
        termination?.output ?? `${TOOL_ERROR_PREFIX} ${error.message}`,
        termination?.exitCode ?? 1,
        termination?.cancelled,
      );
    });

    child.on("close", (code) => {
      const exitCode =
        termination?.exitCode ?? (typeof code === "number" ? code : 1);
      stdout.end();
      stderr.end();
      const totalChars = stdout.total + stderr.total;
      const combined = formatTruncatedOutput(stdout.text + stderr.text, totalChars, maxOutput);
      finish(
        termination?.output ?? (combined || "(no output)"),
        exitCode,
        termination?.cancelled ?? false,
      );
    });

    timer = setTimeout(() => {
      terminate(`${TOOL_ERROR_PREFIX} command timed out after ${timeout}s`, null, false, child);
    }, timeout * 1000 + 50);
    timer.unref();

    function cleanup(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    }
  });
}

export class BackgroundManager {
  readonly tasks: Record<string, BackgroundTask> = {};
  private readonly results: Record<string, string> = {};
  private readonly ready: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private counter = 0;

  constructor(
    readonly workdir: string,
    readonly timeout = 120,
    readonly maxOutput = 30000,
  ) {
    validateTimeoutSeconds(timeout, "background timeout");
    if (!Number.isInteger(maxOutput) || maxOutput < 0) {
      throw new RangeError("maxOutput must be a non-negative integer");
    }
  }

  start(command: string): string {
    const trimmed = String(command).trim();
    if (!trimmed) throw new Error("Bash command cannot be empty");
    this.counter += 1;
    const taskId = `bg_${String(this.counter).padStart(4, "0")}`;
    this.tasks[taskId] = { command: trimmed, status: "running" };
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const run = this.run(taskId, trimmed, controller.signal);
    this.running.set(taskId, run);
    return taskId;
  }

  private async run(taskId: string, command: string, signal: AbortSignal): Promise<void> {
    let output: string;
    let status: string;
    try {
      const result = await runBashProcess(
        command,
        this.workdir,
        this.timeout,
        this.maxOutput,
        signal,
      );
      output = result.output;
      status = result.exitCode === 0 ? "completed" : result.cancelled ? "cancelled" : "failed";
    } catch (error) {
      // worker 崩溃也要记录为 failed
      output = error instanceof Error ? `Error: ${error.name}: ${error.message}` : String(error);
      status = "failed";
    } finally {
      this.controllers.delete(taskId);
      this.running.delete(taskId);
    }
    const task = this.tasks[taskId];
    if (task === undefined) return;
    task.status = status;
    this.results[taskId] = output;
    this.ready.push(taskId);
  }

  hasRunning(): boolean {
    return Object.values(this.tasks).some((task) => task.status === "running");
  }

  collect(): string[] {
    const ready: Array<[string, BackgroundTask, string]> = [];
    for (const taskId of this.ready) {
      const task = this.tasks[taskId];
      const result = this.results[taskId] ?? "";
      delete this.tasks[taskId];
      delete this.results[taskId];
      if (task !== undefined) ready.push([taskId, task, result]);
    }
    this.ready.length = 0;
    return ready.map(
      ([taskId, task, result]) =>
        `<task_notification>\n` +
        `  <task_id>${taskId}</task_id>\n` +
        `  <status>${task.status}</status>\n` +
        `  <command>${task.command}</command>\n` +
        `  <summary>${result.slice(0, 500)}</summary>\n` +
        `</task_notification>`,
    );
  }

  async stopAll(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.all([...this.running.values()]);
  }
}
