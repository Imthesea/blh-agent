import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { terminateProcessTree } from "../../src/process/terminate.js";
import { removeDirWithRetries } from "../helpers/fs.js";

describe("terminateProcessTree", () => {
  it("terminates a child process and waits for its exit", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "terminate-test-"));
    try {
      const pidFile = path.join(workdir, "pid.txt");
      await fs.writeFile(
        path.join(workdir, "slow.js"),
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 60000);`,
      );
      const child = spawn(process.execPath, ["slow.js"], {
        cwd: workdir,
        detached: process.platform !== "win32",
        stdio: "ignore",
      });

      let pid = 0;
      for (let attempt = 0; attempt < 50 && pid === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          pid = Number(await fs.readFile(pidFile, "utf8"));
        } catch {
          // pid 文件尚未写入。
        }
      }
      expect(pid).toBeGreaterThan(0);

      await terminateProcessTree(child, 1000);

      expect(child.exitCode ?? child.signalCode).not.toBeNull();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await removeDirWithRetries(workdir);
    }
  }, 10000);
});
