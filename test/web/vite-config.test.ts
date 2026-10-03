import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

type ProxyConfig = { server?: { proxy?: Record<string, { target: string }> } };

async function loadViteConfig(): Promise<ProxyConfig> {
  vi.resetModules();
  return (await import("../../apps/web/vite.config.js")).default as ProxyConfig;
}

function proxyTarget(config: ProxyConfig): string {
  const proxy = config.server?.proxy?.["/api"];
  if (proxy === undefined) throw new Error("Vite /api proxy is missing");
  return proxy.target;
}

describe("web vite proxy port", () => {
  it("defaults to port 8123", async () => {
    expect(proxyTarget(await loadViteConfig())).toBe("http://127.0.0.1:8123");
  });

  it("uses BLH_WEB_PORT", async () => {
    vi.stubEnv("BLH_WEB_PORT", "8300");
    expect(proxyTarget(await loadViteConfig())).toBe("http://127.0.0.1:8300");
  });

  it("lets BLH_API_TARGET override the generated target", async () => {
    vi.stubEnv("BLH_WEB_PORT", "8300");
    vi.stubEnv("BLH_API_TARGET", "http://127.0.0.1:18123");
    expect(proxyTarget(await loadViteConfig())).toBe("http://127.0.0.1:18123");
  });

  it("rejects an invalid BLH_WEB_PORT", async () => {
    vi.stubEnv("BLH_WEB_PORT", "not-a-port");
    await expect(loadViteConfig()).rejects.toThrow("BLH_WEB_PORT");
  });
});
