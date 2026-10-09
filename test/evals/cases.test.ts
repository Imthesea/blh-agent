import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockProvider, makeToolCallMessage, makeTextMessage } from "../integration/helpers.js";
import { runCase } from "../../evals/runner.js";
import { createSandboxHarness } from "../../evals/sandbox.js";
import { loadCases } from "../../evals/load-cases.js";
import type { ChatMessage, Config } from "../../src/contracts/types.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-eval-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** 每个用例对应的 gold 脚本：按用例期望编排工具调用，跑完应全通过。 */
const FIXTURES: Record<string, ChatMessage[]> = {
  "write-and-read": [
    makeToolCallMessage("write_file", { path: "hello.txt", content: "world" }, "c1"),
    makeToolCallMessage("read_file", { path: "hello.txt" }, "c2"),
    makeTextMessage("done"),
  ],
  "write-two-files": [
    makeToolCallMessage("write_file", { path: "a.txt", content: "A" }, "c1"),
    makeToolCallMessage("write_file", { path: "b.txt", content: "B" }, "c2"),
    makeTextMessage("done"),
  ],
  "glob-ts": [
    makeToolCallMessage("glob", { pattern: "*.ts" }, "c1"),
    makeTextMessage("done"),
  ],
  "bash-echo": [
    makeToolCallMessage("bash", { command: "echo hello" }, "c1"),
    makeTextMessage("done"),
  ],
  "chitchat": [
    makeTextMessage("我是 blh，一个编程智能体"),
  ],
  "single-write": [
    makeToolCallMessage("write_file", { path: "only.txt", content: "x" }, "c1"),
    makeTextMessage("done"),
  ],
  "safe-bash": [
    makeToolCallMessage("bash", { command: "echo hello" }, "c1"),
    makeTextMessage("done"),
  ],
  "report-content": [
    makeTextMessage("结果是 world"),
  ],
  "submit-result": [
    makeToolCallMessage("write_file", { path: "hello.txt", content: "world" }, "c1"),
    makeToolCallMessage("submit_result", { verdict: "done", summary: "created hello.txt" }, "c2"),
    makeTextMessage("done"),
  ],
};

const cases = loadCases(fileURLToPath(new URL("../../evals/cases.jsonl", import.meta.url)));

describe("声明式题库离线评测（gold 脚本全通过）", () => {
  for (const evalCase of cases) {
    it(evalCase.id, async () => {
      const script = FIXTURES[evalCase.id];
      expect(script, `缺少 ${evalCase.id} 的 fixture 脚本`).toBeDefined();

      const config: Config = {
        apiKey: "k",
        model: "m",
        workdir: tempDir,
        bashTimeout: 120,
        maxOutputChars: 30000,
      };
      // 离线用 full 策略（含 bash），因为题库里有 bash 用例；真实跑分才用 safe 沙箱。
      const harness = createSandboxHarness(config, new MockProvider(script!), { policy: "full" });
      const { result } = await runCase(harness, evalCase);

      for (const check of result.checks) {
        expect(check.pass, `${check.name}: ${check.detail}`).toBe(true);
      }
      expect(result.passed).toBe(true);
    });
  }
});