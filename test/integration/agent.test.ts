import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../../src/runtime/harness.js";
import { HookBus } from "../../src/runtime/hooks.js";
import { PRE_TOOL_USE } from "../../src/contracts/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltinTools } from "../../src/tools/index.js";
import { DEFAULT_RULES } from "../../src/security/rules.js";
import { makePermissionHook } from "../../src/security/approval.js";
import { MockProvider, makeToolCallMessage, makeTextMessage } from "./helpers.js";
import type { Config } from "../../src/contracts/types.js";

let tempDir: string;
let config: Config;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-e2e-"));
  config = {
    apiKey: "k",
    model: "m",
    workdir: tempDir,
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function buildHarness(
  script: ConstructorParameters<typeof MockProvider>[0],
  askAnswer = "y",
) {
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, config);
  const hooks = new HookBus();
  const permissionHook = makePermissionHook(DEFAULT_RULES, async () =>
    askAnswer === "y" ? "allow" : "deny",
  );
  hooks.register(PRE_TOOL_USE, (payload) => permissionHook(payload.name, payload.input));
  return new Harness(config, new MockProvider(script), tools, hooks);
}

describe("agent end-to-end", () => {
  it("writes and reads a file through tool calls", async () => {
    const harness = buildHarness([
      makeToolCallMessage("write_file", { path: "hello.txt", content: "world" }, "c1"),
      makeToolCallMessage("read_file", { path: "hello.txt" }, "c2"),
      makeTextMessage("I wrote hello.txt and read it back: world"),
    ]);
    const transcript = harness.newTranscript();
    await harness.runTurn(transcript, "create and verify hello.txt");
    await expect(fs.readFile(path.join(tempDir, "hello.txt"), "utf8")).resolves.toBe(
      "world",
    );
    const toolResults = transcript.messages.filter((message) => message.role === "tool");
    expect(toolResults[0]?.content).toContain("wrote 5 chars");
    expect(toolResults[1]?.content).toBe("1\tworld");
    expect(transcript.lastAssistantTextAfter(0)).toContain("world");
  });

  it("bash is denied when user answers no", async () => {
    const harness = buildHarness(
      [
        makeToolCallMessage("bash", { command: "ls" }, "c1"),
        makeTextMessage("I was not allowed."),
      ],
      "n",
    );
    const transcript = harness.newTranscript();
    await harness.runTurn(transcript, "list files");
    const toolResults = transcript.messages.filter((message) => message.role === "tool");
    expect(toolResults[0]?.content).toBe("denied by user");
  });

  it("git push --force is denied by rule without asking", async () => {
    const harness = buildHarness(
      [
        makeToolCallMessage("bash", { command: "git push --force" }, "c1"),
        makeTextMessage("blocked"),
      ],
      "y", // 即使答 y 也不应被问到
    );
    const transcript = harness.newTranscript();
    await harness.runTurn(transcript, "force push");
    const toolResults = transcript.messages.filter((message) => message.role === "tool");
    expect(toolResults[0]?.content).toBe(
      "denied by permission rule (bash: git push --force)",
    );
  });
});
