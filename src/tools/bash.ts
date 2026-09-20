import { spawn, execFile, type ChildProcess } from "node:child_process";

export function runBash(
  workdir: string,
  defaultTimeout: number,
  maxOutputChars: number,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof args.command !== "string") throw new TypeError("command must be a string");
  const command = args.command;
  const timeoutSec = typeof args.timeout === "number" ? args.timeout : defaultTimeout;

  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(shell, shellArgs, {
      cwd: workdir,
      detached: process.platform !== "win32",
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      void killTree(child).then(() => resolve("error: command cancelled"));
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(`error: ${error.message}`);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const combinedOutput = stdout + (stderr ? `\n(stderr):\n${stderr}` : "");
      const exitCode = typeof code === "number" ? code : 1;
      resolve(formatBashOutput(combinedOutput, exitCode, maxOutputChars));
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void killTree(child).then(() =>
        resolve(`error: command timed out after ${timeoutSec}s`),
      );
    }, timeoutSec * 1000 + 50);
    timer.unref();
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
  exitCode: number,
  maxOutputChars: number,
): string {
  const total = output.length;
  let text = output;
  if (total > maxOutputChars) {
    text = output.slice(0, maxOutputChars) + `\n... [truncated, ${total} chars total]`;
  }
  if (!text.trim()) return `(exit code ${exitCode})`;
  return exitCode === 0 ? text.trimEnd() : `${text.trimEnd()}\n(exit code ${exitCode})`;
}
