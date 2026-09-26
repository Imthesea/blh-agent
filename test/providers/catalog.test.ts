import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const PROVIDER_KEY_ENVS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const env of PROVIDER_KEY_ENVS) {
    savedEnv[env] = process.env[env];
    delete process.env[env];
  }
});

afterEach(() => {
  for (const env of PROVIDER_KEY_ENVS) {
    if (savedEnv[env] === undefined) delete process.env[env];
    else process.env[env] = savedEnv[env];
  }
});

describe("catalog", () => {
  it("内置 provider 存在且 deepseek 排第一", async () => {
    const { listProviders } = await import("../../src/providers/catalog.js");
    const ids = listProviders();
    expect(ids[0]).toBe("deepseek");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("qwen");
    expect(ids).toContain("kimi");
  });

  it("getProviderDefinition 返回正确描述", async () => {
    const { getProviderDefinition } = await import("../../src/providers/catalog.js");
    expect(getProviderDefinition("deepseek").defaultModel).toBe("deepseek-chat");
    expect(getProviderDefinition("anthropic").api).toBe("anthropic");
    expect(getProviderDefinition("qwen").baseUrl).toContain("dashscope");
    expect(getProviderDefinition("deepseek").apiKeyEnv).toEqual(["DEEPSEEK_API_KEY", "OPENAI_API_KEY"]);
  });

  it("未知 provider 抛错并列出可用项", async () => {
    const { getProviderDefinition } = await import("../../src/providers/catalog.js");
    expect(() => getProviderDefinition("nope")).toThrow(/未知 provider 'nope'/);
  });

  it("registerProvider 新增与覆盖同名", async () => {
    const { registerProvider, getProviderDefinition } = await import("../../src/providers/catalog.js");
    registerProvider({ id: "custom", name: "Custom", api: "openai", baseUrl: "http://x", apiKeyEnv: ["CUSTOM_KEY"], defaultModel: "m" });
    expect(getProviderDefinition("custom").name).toBe("Custom");
    registerProvider({ id: "custom", name: "Custom2", api: "openai", baseUrl: "http://x", apiKeyEnv: ["CUSTOM_KEY"], defaultModel: "m" });
    expect(getProviderDefinition("custom").name).toBe("Custom2");
  });

  it("findFirstConfiguredProvider 返回第一个有 key 的 provider", async () => {
    const { findFirstConfiguredProvider } = await import("../../src/providers/catalog.js");
    expect(findFirstConfiguredProvider()).toBeUndefined();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    expect(findFirstConfiguredProvider()?.id).toBe("anthropic");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds");
    expect(findFirstConfiguredProvider()?.id).toBe("deepseek");
  });
});
