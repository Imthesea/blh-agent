import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();

// 会影响 loadConfig 解析的环境变量：vitest 会自动加载仓库根 .env，机器上也可能有系统环境变量（如 DASHSCOPE_API_KEY）
const CONFIG_ENVS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "BLH_PROVIDER",
  "BLH_BASH_TIMEOUT",
  "BLH_MAX_OUTPUT_CHARS",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const env of CONFIG_ENVS) {
    savedEnv[env] = process.env[env];
    delete process.env[env];
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const env of CONFIG_ENVS) {
    if (savedEnv[env] === undefined) delete process.env[env];
    else process.env[env] = savedEnv[env];
  }
});

describe("loadConfig provider/model", () => {
  let tmpDir: string;
  let tmpUserDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-"));
    tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "config-user-"));
    process.chdir(tmpDir);
    vi.stubEnv("USERPROFILE", tmpUserDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpUserDir, { recursive: true, force: true });
  });

  it("默认 provider 为 deepseek，model 用其 defaultModel", async () => {
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.provider).toBe("deepseek");
    expect(config.model).toBe("deepseek-chat");
    expect(config.baseUrl).toBe("https://api.deepseek.com");
    expect(config.apiKey).toBe("");
    expect(config.mcpServers).toEqual([]);
  });

  it("BLH_PROVIDER 环境变量指定 provider", async () => {
    vi.stubEnv("BLH_PROVIDER", "anthropic");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-5");
  });

  it("配置文件 .blh/config.yaml 覆盖默认", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "config.yaml"), "provider: qwen\nmodel: qwen-plus\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.provider).toBe("qwen");
    expect(config.model).toBe("qwen-plus");
  });

  it("全局 ~/.blh/config.yaml 优先于默认，项目 .blh/config.yaml 再覆盖全局", async () => {
    mkdirSync(path.join(tmpUserDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpUserDir, ".blh", "config.yaml"), "provider: kimi\n");
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "config.yaml"), "provider: qwen\n");
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().provider).toBe("qwen");
  });

  it("cli 覆盖一切", async () => {
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig(undefined, { provider: "anthropic", model: "claude-x" });
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-x");
  });

  it("显式 provider 写入 settings 记忆", async () => {
    const { loadConfig } = await import("../../src/core/config.js");
    const { loadSettings } = await import("../../src/core/settings.js");
    vi.stubEnv("BLH_PROVIDER", "qwen");
    loadConfig();
    expect(loadSettings().provider).toBe("qwen");
  });
});

describe("loadConfig mcp.yaml", () => {
  let tmpDir: string;
  let tmpUserDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-mcp-"));
    tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "config-mcp-user-"));
    process.chdir(tmpDir);
    vi.stubEnv("USERPROFILE", tmpUserDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpUserDir, { recursive: true, force: true });
  });

  it("加载 .blh/mcp.yaml（stdio 与 http）", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".blh", "mcp.yaml"),
      [
        "- name: web-search",
        "  command: npx",
        '  args: ["-y", "open-websearch@latest"]',
        "- name: hotel",
        "  url: https://mcp.example.com/mcp",
        "  headers:",
        "    Authorization: Bearer abc",
        "",
      ].join("\n"),
    );
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().mcpServers).toEqual([
      { name: "web-search", command: "npx", args: ["-y", "open-websearch@latest"] },
      { name: "hotel", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" } },
    ]);
  });

  it("全局与项目 mcp.yaml 按 name 合并，项目覆盖同名", async () => {
    mkdirSync(path.join(tmpUserDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpUserDir, ".blh", "mcp.yaml"), "- name: shared\n  url: https://shared\n");
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "mcp.yaml"), "- name: shared\n  url: https://project-override\n- name: local\n  command: npx\n");
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().mcpServers).toEqual([
      { name: "shared", url: "https://project-override" },
      { name: "local", command: "npx" },
    ]);
  });

  it("mcp.yaml 不是数组时抛 ConfigError", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "mcp.yaml"), "name: not-array\n");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("mcp.yaml 某项缺少 name 时抛 ConfigError", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "mcp.yaml"), "- command: npx\n");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

describe("loadConfig 数值与 api_key", () => {
  let tmpDir: string;
  let tmpUserDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-num-"));
    tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "config-num-user-"));
    process.chdir(tmpDir);
    vi.stubEnv("USERPROFILE", tmpUserDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpUserDir, { recursive: true, force: true });
  });

  it("api_key 从配置文件读取（环境变量不再读）", async () => {
    mkdirSync(path.join(tmpDir, ".blh"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".blh", "config.yaml"), "api_key: sk-file\n");
    const { loadConfig } = await import("../../src/core/config.js");
    expect(loadConfig().apiKey).toBe("sk-file");
  });

  it("非法整数抛 ConfigError", async () => {
    vi.stubEnv("BLH_BASH_TIMEOUT", "abc");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("负整数抛 ConfigError", async () => {
    vi.stubEnv("BLH_BASH_TIMEOUT", "-1");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
