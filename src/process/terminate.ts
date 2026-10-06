import { execFile, type ChildProcess } from "node:child_process";

const DEFAULT_FORCE_EXIT_MS = 1000;
const PROCESS_TREE_TIMEOUT_MS = 8000;

/** 终止子进程及其整个进程树，先杀整棵树，超时后再用 SIGKILL 强杀。 */
export async function terminateProcessTree(
  child: ChildProcess,
  forceExitMs = DEFAULT_FORCE_EXIT_MS,
): Promise<void> {
  if (child.pid === undefined) return;

  const exited = waitForExit(child);
  const treeKilled = await killProcessTree(child);
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (!treeKilled) {
    try {
      child.kill("SIGKILL");
    } catch {
      // close/error 监听负责处理已经退出的进程。
    }
  }

  await Promise.race([exited, delay(forceExitMs)]);
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    child.kill("SIGKILL");
  } catch {
    // close/error 监听负责处理已经退出的进程。
  }
  await Promise.race([exited, delay(forceExitMs)]);
}

/** 返回一个 Promise，在子进程触发 close 或 error 事件（即已退出）时 resolve。 */
function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();

    const settle = () => {
      child.removeListener("close", settle);
      child.removeListener("error", settle);
      resolve();
    };
    child.once("close", settle);
    child.once("error", settle);
  });
}

/** 杀掉进程树：Windows 用 taskkill /T /F，非 Windows 用 process.kill 杀整个进程组。 */
function killProcessTree(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (pid === undefined) return resolve(false);

    if (process.platform === "win32") {
      execFile(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        { timeout: PROCESS_TREE_TIMEOUT_MS, windowsHide: true },
        (error) => resolve(error === undefined),
      );
      return;
    }

    try {
      process.kill(-pid, "SIGKILL");
      resolve(true);
    } catch {
      child.kill("SIGKILL");
      resolve(true);
    }
  });
}

/** 延时指定毫秒后 resolve，定时器使用 unref 以免阻塞进程退出。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
