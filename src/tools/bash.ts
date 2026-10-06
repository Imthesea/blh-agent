import { spawn, type ChildProcess } from "node:child_process";
import {
  BoundedOutputCollector,
  formatTruncatedOutput,
  validateTimeoutSeconds,
} from "../process/output.js";
import { terminateProcessTree } from "../process/terminate.js";

export function runBash(
  workdir: string,
  defaultTimeout: number,
  maxOutputChars: number,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof args.command !== "string") throw new TypeError("command must be a string");
  const command = args.command;
  const timeoutSec = validateTimeoutSeconds(
    args.timeout === undefined ? defaultTimeout : args.timeout,
  );
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 0) {
    throw new RangeError("maxOutputChars must be a non-negative integer");
  }

  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    const stdout = new BoundedOutputCollector(maxOutputChars);
    const stderr = new BoundedOutputCollector(maxOutputChars);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let terminationOutput: string | undefined;

    const finish = (output: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(output);
    };

    const terminate = (output: string, child?: ChildProcess): void => {
      if (settled) return;
      terminationOutput = output;
      cleanup();
      const terminated =
        child === undefined ? Promise.resolve() : terminateProcessTree(child);
      void terminated.then(() => finish(output));
    };

    if (signal?.aborted) {
      finish("error: command cancelled");
      return;
    }

    const child = spawn(shell, shellArgs, {
      cwd: workdir,
      detached: process.platform !== "win32",
    });

    const onAbort = () => {
      terminate("error: command cancelled", child);
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

    child.on("error", (error) => {
      finish(terminationOutput ?? `error: ${error.message}`);
    });

    child.on("close", (code) => {
      if (terminationOutput !== undefined) {
        finish(terminationOutput);
        return;
      }
      stdout.end();
      stderr.end();
      const hasStderr = stderr.total > 0;
      const separatorLength = hasStderr ? "\n(stderr):\n".length : 0;
      const totalChars = stdout.total + separatorLength + stderr.total;
      const combinedOutput = stdout.text + (hasStderr ? `\n(stderr):\n${stderr.text}` : "");
      const exitCode = typeof code === "number" ? code : 1;
      finish(formatBashOutput(combinedOutput, totalChars, exitCode, maxOutputChars));
    });

    timer = setTimeout(() => {
      terminate(`error: command timed out after ${timeoutSec}s`, child);
    }, timeoutSec * 1000 + 50);
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

function formatBashOutput(
  output: string,
  totalChars: number,
  exitCode: number,
  maxOutputChars: number,
): string {
  const text = formatTruncatedOutput(output, totalChars, maxOutputChars);
  if (!text.trim()) return `(exit code ${exitCode})`;
  return exitCode === 0 ? text.trimEnd() : `${text.trimEnd()}\n(exit code ${exitCode})`;
}
