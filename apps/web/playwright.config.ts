import { defineConfig } from "@playwright/test";

// e2e 使用独立端口（vite 5174 / mock 18123），避免 reuseExistingServer
// 复用到本地正在运行的真实 dev 环境（5173 / 8123）导致数据断言失败。
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // mock server 为单进程内存态，并行 worker 会互相污染（如审批弹窗全局弹出），故串行。
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5174",
  },
  webServer: [
    {
      command: "pnpm --filter @blh/web dev -- --port 5174 --strictPort",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      env: {
        BLH_API_TARGET: "http://127.0.0.1:18123",
      },
    },
    {
      command: "node e2e/mock-server.mjs",
      url: "http://127.0.0.1:18123/api/session",
      reuseExistingServer: false,
      env: {
        MOCK_PORT: "18123",
      },
    },
  ],
});
