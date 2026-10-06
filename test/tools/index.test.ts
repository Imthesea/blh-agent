import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Config } from "../../src/contracts/types.js";

let dir: string;
let config: Config;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-builtin-"));
  config = {
    apiKey: "k",
    model: "m",
    workdir: dir,
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("registerBuiltinTools", () => {
  it("registers the 5 builtin tools", async () => {
    const { registerBuiltinTools } = await import("../../src/tools/index.js");
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, config);
    expect(reg.list().map((t) => t.name).sort()).toEqual([
      "bash",
      "edit_file",
      "glob",
      "read_file",
      "write_file",
    ]);
  });

  it("bash tool schema includes run_in_background", async () => {
    const { registerBuiltinTools } = await import("../../src/tools/index.js");
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, config);
    const bash = reg.list().find((t) => t.name === "bash");
    expect(bash?.parameters).toEqual({
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120)" },
        run_in_background: { type: "boolean" },
      },
      required: ["command"],
    });
  });

  it("end-to-end: write then read via dispatch", async () => {
    const { registerBuiltinTools } = await import("../../src/tools/index.js");
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, config);
    await reg.dispatch("write_file", { path: "a.txt", content: "hi" });
    await expect(reg.dispatch("read_file", { path: "a.txt" })).resolves.toBe("1\thi");
  });
});
