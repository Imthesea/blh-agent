import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHarness } from "../../src/cli/buildHarness.js";
import { MockProvider } from "../integration/helpers.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-inject-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("buildHarness provider 注入", () => {
  it("注入的 provider 被 harness 采用", async () => {
    const mock = new MockProvider([]);
    const harness = buildHarness(tempDir, undefined, undefined, false, { provider: mock });
    try {
      expect(harness.provider).toBe(mock);
    } finally {
      await harness.dispose();
    }
  });
});