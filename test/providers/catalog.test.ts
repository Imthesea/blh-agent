import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const PROVIDER_KEY_ENVS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "BLH_CONTEXT_WINDOW",
  "BLH_MAX_OUTPUT_TOKENS",
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

  it("每个内置 provider 都有正整数的窗口与输出上限", async () => {
    const { getProviderDefinition, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } =
      await import("../../src/providers/catalog.js");
    const builtinIds = ["deepseek", "anthropic", "qwen", "kimi"];
    for (const id of builtinIds) {
      const def = getProviderDefinition(id);
      expect(Number.isInteger(def.contextWindow)).toBe(true);
      expect(def.contextWindow).toBeGreaterThan(0);
      expect(Number.isInteger(def.maxOutputTokens)).toBe(true);
      expect(def.maxOutputTokens).toBeGreaterThan(0);
    }
    expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(0);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
  });

  it("resolveContextWindow: override 优先、未知 provider 走默认、非法值回退", async () => {
    const { resolveContextWindow, getProviderDefinition, DEFAULT_CONTEXT_WINDOW } =
      await import("../../src/providers/catalog.js");
    const deepseek = getProviderDefinition("deepseek");
    expect(resolveContextWindow(deepseek)).toBe(deepseek.contextWindow);
    expect(resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(deepseek, 123456)).toBe(123456);
    expect(resolveContextWindow(deepseek, -1)).toBe(deepseek.contextWindow);
    expect(resolveContextWindow(undefined, -1)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("resolveContextWindow: env 覆盖内置", async () => {
    const { resolveContextWindow, getProviderDefinition } = await import("../../src/providers/catalog.js");
    const deepseek = getProviderDefinition("deepseek");
    process.env["BLH_CONTEXT_WINDOW"] = "999999";
    expect(resolveContextWindow(deepseek)).toBe(999999);
    process.env["BLH_CONTEXT_WINDOW"] = "not-a-number";
    expect(resolveContextWindow(deepseek)).toBe(deepseek.contextWindow);
  });

  it("resolveMaxOutputTokens: override 优先、默认、非法回退", async () => {
    const { resolveMaxOutputTokens, getProviderDefinition, DEFAULT_MAX_OUTPUT_TOKENS } =
      await import("../../src/providers/catalog.js");
    const kimi = getProviderDefinition("kimi");
    expect(resolveMaxOutputTokens(kimi)).toBe(kimi.maxOutputTokens);
    expect(resolveMaxOutputTokens(undefined)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(kimi, 2000)).toBe(2000);
    expect(resolveMaxOutputTokens(kimi, 0)).toBe(kimi.maxOutputTokens);
  });
});
