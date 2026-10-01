import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

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
        target: process.env.BLH_API_TARGET ?? "http://127.0.0.1:8123",
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
