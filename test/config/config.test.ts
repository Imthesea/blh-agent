import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpRoot = "";
let fakeHome = "";

const CLEAR_ENVS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "BLH_PROVIDER",
  "BLH_BASH_TIMEOUT",
  "BLH_MAX_OUTPUT_CHARS",
];

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "blh-config-"));
  fakeHome = mkdtempSync(path.join(os.tmpdir(), "blh-home-"));
  // 把 os.homedir() 指到临时目录，隔离 ~/.blh/config.yaml / settings.json 的读写。
  vi.stubEnv("USERPROFILE", fakeHome);
  vi.stubEnv("HOME", fakeHome);
  for (const key of CLEAR_ENVS) vi.stubEnv(key, "");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("loadConfig 诊断聚合", () => {
  it("一次收集多个配置错误，并返回兜底值", async () => {
    const { loadConfig } = await import("../../src/config/config.js");
    const { Diagnostics } = await import("../../src/contracts/diagnostics.js");
    mkdirSync(path.join(tmpRoot, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpRoot, ".blh", "mcp.yaml"), "- 123\n- name: ok\n  command: echo\n", "utf8");

    const diagnostics = new Diagnostics();
    const config = loadConfig(
      { configRoot: tmpRoot, cli: { provider: "nope", bash_timeout: "abc", max_output_chars: "-5" } },
      diagnostics,
    );

    expect(diagnostics.hasErrors()).toBe(true);
    const messages = diagnostics.errors().map((d) => d.message).join("\n");
    expect(messages).toContain("未知 provider 'nope'");
    expect(messages).toContain("bash_timeout 不是合法的整数");
    expect(messages).toContain("max_output_chars 不能为负数");
    expect(messages).toContain("mcp.yaml[0] 必须是对象");

    expect(config.provider).toBe("deepseek");
    expect(config.bashTimeout).toBe(120);
    expect(config.maxOutputChars).toBe(30000);
    expect(config.mcpServers?.map((s) => s.name)).toContain("ok");
  });

  it("合法配置不产生任何错误", async () => {
    const { loadConfig } = await import("../../src/config/config.js");
    const { Diagnostics } = await import("../../src/contracts/diagnostics.js");

    const diagnostics = new Diagnostics();
    const config = loadConfig(
      { configRoot: tmpRoot, cli: { provider: "deepseek", bash_timeout: "60" } },
      diagnostics,
    );

    expect(diagnostics.hasErrors()).toBe(false);
    expect(config.provider).toBe("deepseek");
    expect(config.bashTimeout).toBe(60);
  });

  it("settings 里的未知 provider 产生 warning 且不阻断", async () => {
    const { loadConfig } = await import("../../src/config/config.js");
    const { Diagnostics } = await import("../../src/contracts/diagnostics.js");
    mkdirSync(path.join(fakeHome, ".blh"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".blh", "settings.json"), JSON.stringify({ provider: "nope" }), "utf8");

    const diagnostics = new Diagnostics();
    const config = loadConfig({ configRoot: tmpRoot }, diagnostics);

    expect(diagnostics.hasErrors()).toBe(false);
    expect(diagnostics.warnings().map((d) => d.message).join("\n")).toContain("未知");
    expect(config.provider).toBe("deepseek");
  });

  it("不传 diagnostics 时仍抛 ConfigError 并聚合错误", async () => {
    const { loadConfig, ConfigError } = await import("../../src/config/config.js");

    expect(() =>
      loadConfig({ configRoot: tmpRoot, cli: { provider: "nope", bash_timeout: "abc" } }),
    ).toThrow(ConfigError);
  });
});