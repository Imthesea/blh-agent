import { describe, it, expect, vi, afterEach } from "vitest";
import type { Config } from "../../src/contracts/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const noProvider: Config = {
  apiKey: "",
  model: "m",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

describe("createProvider", () => {
  it("deepseek 走 openai 兼容适配器", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds");
    const { createProvider } = await import("../../src/providers/registry.js");
    const { OpenAICompatProvider } = await import("../../src/providers/openai-compat.js");
    const provider = createProvider({ ...noProvider, provider: "deepseek" });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it("anthropic 走原生适配器", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    const { createProvider } = await import("../../src/providers/registry.js");
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const provider = createProvider({ ...noProvider, provider: "anthropic" });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("未设置 provider 时兜底 deepseek", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds");
    const { createProvider } = await import("../../src/providers/registry.js");
    const { OpenAICompatProvider } = await import("../../src/providers/openai-compat.js");
    const provider = createProvider(noProvider);
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it("缺 key 时抛错并列明环境变量", async () => {
    vi.stubEnv("MOONSHOT_API_KEY", "");
    const { createProvider } = await import("../../src/providers/registry.js");
    expect(() => createProvider({ ...noProvider, provider: "kimi" })).toThrow(/MOONSHOT_API_KEY/);
  });

  it("配置文件 api_key 优先于环境变量", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-env");
    const { resolveApiKey } = await import("../../src/providers/registry.js");
    const { getProviderDefinition } = await import("../../src/providers/catalog.js");
    expect(resolveApiKey({ ...noProvider, apiKey: "sk-file" }, getProviderDefinition("deepseek"))).toBe("sk-file");
  });

  it("传入 diagnostics 时缺 key 记为 error 诊断而不抛错", async () => {
    vi.stubEnv("MOONSHOT_API_KEY", "");
    const { createProvider } = await import("../../src/providers/registry.js");
    const { Diagnostics } = await import("../../src/contracts/diagnostics.js");
    const { OpenAICompatProvider } = await import("../../src/providers/openai-compat.js");
    const diagnostics = new Diagnostics();
    const provider = createProvider({ ...noProvider, provider: "kimi" }, diagnostics);
    expect(diagnostics.hasErrors()).toBe(true);
    expect(diagnostics.errors().map((d) => d.message).join("")).toContain("MOONSHOT_API_KEY");
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it("未知 provider 时既记诊断也抛错", async () => {
    const { createProvider } = await import("../../src/providers/registry.js");
    const { Diagnostics } = await import("../../src/contracts/diagnostics.js");
    const diagnostics = new Diagnostics();
    expect(() => createProvider({ ...noProvider, provider: "nope" }, diagnostics)).toThrow(/未知 provider/);
    expect(diagnostics.hasErrors()).toBe(true);
  });
});
