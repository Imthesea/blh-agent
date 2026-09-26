import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpUserDir: string;

beforeEach(() => {
  tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "settings-"));
  vi.stubEnv("USERPROFILE", tmpUserDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpUserDir, { recursive: true, force: true });
});

describe("settings", () => {
  it("无文件时返回空对象", async () => {
    const { loadSettings } = await import("../../src/core/settings.js");
    expect(loadSettings()).toEqual({});
  });

  it("保存后可读回", async () => {
    const { loadSettings, saveSettings } = await import("../../src/core/settings.js");
    saveSettings({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(loadSettings()).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("损坏文件容错返回空对象", async () => {
    const { loadSettings } = await import("../../src/core/settings.js");
    mkdirSync(path.join(tmpUserDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpUserDir, ".blh", "settings.json"), "{not json");
    expect(loadSettings()).toEqual({});
  });
});
