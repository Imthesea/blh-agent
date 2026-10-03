import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  BoundedOutputCollector,
  formatTruncatedOutput,
  validateTimeoutSeconds,
} from "../process/output.js";

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

    if (signal?.aborted) {
      resolve("error: command cancelled");
      return;
    }

    const child = spawn(shell, shellArgs, {
      cwd: workdir,
      detached: process.platform !== "win32",
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void killTree(child).then(() => resolve("error: command cancelled"));
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
      if (settled) return;
      settled = true;
      cleanup();
      resolve(`error: ${error.message}`);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.end();
      stderr.end();
      const hasStderr = stderr.total > 0;
      const separatorLength = hasStderr ? "\n(stderr):\n".length : 0;
      const totalChars = stdout.total + separatorLength + stderr.total;
      const combinedOutput = stdout.text + (hasStderr ? `\n(stderr):\n${stderr.text}` : "");
      const exitCode = typeof code === "number" ? code : 1;
      resolve(formatBashOutput(combinedOutput, totalChars, exitCode, maxOutputChars));
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void killTree(child).then(() =>
        resolve(`error: command timed out after ${timeoutSec}s`),
      );
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

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined) return resolve();
    if (process.platform === "win32") {
      // cmd.exe 会派生子进程（如 node），仅杀 cmd.exe 会留下孤儿进程。
      // taskkill /T /F 会连同整个进程树一并强杀。
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve());
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve();
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
