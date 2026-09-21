import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("reads values from environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:8000/v1");
    vi.stubEnv("OPENAI_MODEL", "my-model");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig("/tmp/work");
    expect(config.apiKey).toBe("sk-test");
    expect(config.baseUrl).toBe("http://localhost:8000/v1");
    expect(config.model).toBe("my-model");
    expect(config.workdir).toBe("/tmp/work");
    expect(config.bashTimeout).toBe(120);
    expect(config.maxOutputChars).toBe(30000);
  });

  it("defaults model and baseUrl", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("OPENAI_MODEL", "");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.baseUrl).toBeUndefined();
    expect(config.workdir).toBe(process.cwd());
  });

  it("exits when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { loadConfig } = await import("../../src/core/config.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => loadConfig()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain("没有设置 OPENAI_API_KEY");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("loadConfig .env", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-env-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads values from .env", async () => {
    const savedApiKey = process.env.OPENAI_API_KEY;
    const savedBaseUrl = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    try {
      writeFileSync(
        path.join(tmpDir, ".env"),
        "OPENAI_API_KEY=sk-from-dotenv\nOPENAI_BASE_URL=http://dotenv:1/v1\n",
      );
      const { loadConfig } = await import("../../src/core/config.js");
      const config = loadConfig();
      expect(config.apiKey).toBe("sk-from-dotenv");
      expect(config.baseUrl).toBe("http://dotenv:1/v1");
    } finally {
      if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedApiKey;
      if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = savedBaseUrl;
    }
  });

  it("env vars take precedence over .env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-from-env");
    writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.apiKey).toBe("sk-from-env");
  });
});

describe("loadConfig file/cli", () => {
  let tmpDir: string;
  let tmpUserDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-file-"));
    tmpUserDir = mkdtempSync(path.join(os.tmpdir(), "config-user-"));
    process.chdir(tmpDir);
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("BLH_BASH_TIMEOUT", "");
    vi.stubEnv("BLH_MAX_OUTPUT_CHARS", "");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpUserDir, { recursive: true, force: true });
  });

  it("file overrides defaults", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    writeFileSync(path.join(tmpDir, ".blh.yaml"), "model: file-model\nmax_output_chars: 123\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.model).toBe("file-model");
    expect(config.maxOutputChars).toBe(123);
  });

  it("env overrides file", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "env-model");
    writeFileSync(path.join(tmpDir, ".blh.yaml"), "model: file-model\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.model).toBe("env-model");
  });

  it("cli overrides all", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "env-model");
    writeFileSync(path.join(tmpDir, ".blh.yaml"), "model: file-model\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig(undefined, { model: "cli-model" });
    expect(config.model).toBe("cli-model");
  });

  it("invalid int raises ConfigError", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("BLH_BASH_TIMEOUT", "abc");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("negative int raises ConfigError", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("BLH_BASH_TIMEOUT", "-1");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("user config then project config (project wins)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("USERPROFILE", tmpUserDir);
    mkdirSync(path.join(tmpUserDir, ".config", "blh"), { recursive: true });
    writeFileSync(
      path.join(tmpUserDir, ".config", "blh", "config.yaml"),
      "model: user-model\n",
    );
    writeFileSync(path.join(tmpDir, ".blh.yaml"), "model: project-model\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.model).toBe("project-model");
  });

  it("config file non-mapping raises ConfigError", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    writeFileSync(path.join(tmpDir, ".blh.yaml"), "- a\n- b\n");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("解析 mcp_servers（stdio 与 http 两种）", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    writeFileSync(
      path.join(tmpDir, ".blh.yaml"),
      [
        "mcp_servers:",
        "  - name: web-search",
        "    command: npx",
        '    args: ["-y", "open-websearch@latest"]',
        "  - name: hotel",
        "    url: https://mcp.example.com/mcp",
        "    headers:",
        "      Authorization: Bearer abc",
        "",
      ].join("\n"),
    );
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.mcpServers).toEqual([
      { name: "web-search", command: "npx", args: ["-y", "open-websearch@latest"] },
      { name: "hotel", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" } },
    ]);
  });

  it("mcp_servers 不是数组时抛 ConfigError", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    writeFileSync(path.join(tmpDir, ".blh.yaml"), "mcp_servers: not-an-array\n");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("mcp_servers 某项缺少 name 时抛 ConfigError", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    writeFileSync(path.join(tmpDir, ".blh.yaml"), "mcp_servers:\n  - command: npx\n");
    const { loadConfig, ConfigError } = await import("../../src/core/config.js");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("未配置 mcp_servers 时返回空数组", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.mcpServers).toEqual([]);
  });
});
