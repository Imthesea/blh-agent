import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const webPort = process.env.BLH_WEB_PORT ?? "8123";
if (!/^\d+$/.test(webPort) || Number.parseInt(webPort, 10) < 1 || Number.parseInt(webPort, 10) > 65535) {
  throw new Error("BLH_WEB_PORT must be an integer between 1 and 65535");
}
const apiTarget = process.env.BLH_API_TARGET ?? `http://127.0.0.1:${webPort}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@blh/web-client": path.resolve(root, "../../packages/web-client/src/index.ts"),
      "@blh/logger": path.resolve(root, "../../packages/logger/src/browser.ts"),
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    // 前端启动时自动在默认浏览器打开页面（dev 模式下后端不负责打开浏览器）。
    open: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    // 产出到根 dist/web，与 server/index.ts 的 staticDir() 对齐
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
