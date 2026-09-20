import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-bash-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function runScript(script: string, timeout = 120, maxOutputChars = 30000) {
  await fs.writeFile(path.join(dir, "s.js"), script);
  const { runBash } = await import("../../src/tools/bash.js");
  return runBash(dir, timeout, maxOutputChars, { command: "node s.js" });
}

describe("runBash", () => {
  it("captures stdout", async () => {
    const out = await runScript("console.log('hello')");
    expect(out.trim()).toBe("hello");
  });
  it("clears the timeout timer after the command completes", async () => {
    vi.useFakeTimers();
    try {
      await runScript("console.log('hi')");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("appends non-zero exit code", async () => {
    const out = await runScript("console.log('oops'); process.exit(3)");
    expect(out).toContain("oops");
    expect(out).toContain("(exit code 3)");
  });
  it("returns (exit code N) for empty output", async () => {
    const out = await runScript("process.exit(7)");
    expect(out).toBe("(exit code 7)");
  });
  it("times out long-running commands", async () => {
    const out = await runScript("setTimeout(() => {}, 30000)", 1);
    expect(out).toBe("error: command timed out after 1s");
  }, 15000);
  it.skipIf(process.platform === "win32")("kills the whole process group on timeout", async () => {
    const pidFile = path.join(dir, "pid.txt");
    const command = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(()=>{},1000)"`;
    const { runBash } = await import("../../src/tools/bash.js");
    const out = await runBash(dir, 1, 30000, { command });
    expect(out).toBe("error: command timed out after 1s");

    let pid: number | null = null;
    for (let i = 0; i < 20; i++) {
      try {
        pid = Number(await fs.readFile(pidFile, "utf8"));
        if (Number.isFinite(pid) && pid > 0) break;
      } catch {
        // pid file not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pid).toBeTruthy();

    let alive = true;
    try {
      process.kill(pid as number, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        process.kill(pid as number, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    expect(alive).toBe(false);
  }, 15000);
  it("abort 后强杀正在运行的命令并返回 cancelled", async () => {
    const pidFile = path.join(dir, "pid.txt");
    await fs.writeFile(
      path.join(dir, "pid.js"),
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`,
    );
    const { runBash } = await import("../../src/tools/bash.js");
    const controller = new AbortController();
    const promise = runBash(dir, 120, 30000, { command: "node pid.js" }, controller.signal);

    let pid = 0;
    for (let i = 0; i < 50 && pid === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        pid = Number(await fs.readFile(pidFile, "utf8"));
      } catch {
        /* 还没写 */
      }
    }
    expect(pid).toBeGreaterThan(0);

    controller.abort();
    await expect(promise).resolves.toBe("error: command cancelled");

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 15000);
  it("truncates huge output", async () => {
    const out = await runScript("console.log('x'.repeat(500))", 120, 100);
    expect(out).toContain("... [truncated, 501 chars total]");
    expect(out.length).toBeLessThan(200);
  });
});
