import http from "node:http";
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebServer, type WebContext } from "../src/http.js";
import { SSEBroadcaster } from "../src/bridge.js";
import { SessionManager } from "../src/session.js";
import { ApprovalCoordinator } from "../src/approval.js";
import type { TurnLock, WebTurnRunner } from "../src/types.js";
import type { Server } from "node:http";
import { makeTestSessionStore } from "./helpers.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

async function makeContext(workdir: string, staticDir: string): Promise<WebContext> {
  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));
  const runner: WebTurnRunner = {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: async () => {},
  };
  const lock: TurnLock = { withLock: async <T,>(fn: () => Promise<T>) => fn() };
  const sessionStore = makeTestSessionStore();
  const session = new SessionManager(runner, lock, (event) => broadcaster.broadcast(event), approvals, sessionStore);
  await session.create(workdir);
  return { session, broadcaster, workdir, staticDir, sessionStore };
}

async function listen(ctx: WebContext | Promise<WebContext>): Promise<{ server: Server; url: string }> {
  const server = createWebServer(await ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

let servers: Server[] = [];
let tmpDir: string;
let staticDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-static-"));
  staticDir = path.join(tmpDir, "dist");
  mkdirSync(staticDir, { recursive: true });
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("serveStatic", () => {
  it("返回静态文件与内容类型", async () => {
    writeFileSync(path.join(staticDir, "app.js"), "console.log(1);\n");
    const { server, url } = await listen(makeContext(tmpDir, staticDir));
    servers.push(server);
    const res = await fetch(`${url}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log(1);\n");
  });

  it("不存在的文件返回 404", async () => {
    const { server, url } = await listen(makeContext(tmpDir, staticDir));
    servers.push(server);
    const res = await fetch(`${url}/missing.js`);
    expect(res.status).toBe(404);
  });

  it("路径穿越返回 404", async () => {
    writeFileSync(path.join(tmpDir, "secret.txt"), "secret");
    const { server, url } = await listen(makeContext(tmpDir, staticDir));
    servers.push(server);
    const res = await fetch(`${url}/%2e%2e%2fsecret.txt`);
    expect(res.status).toBe(404);
  });

  it("URL 解码后返回含中文的文件名", async () => {
    writeFileSync(path.join(staticDir, "你好.js"), "中文\n");
    const { server, url } = await listen(makeContext(tmpDir, staticDir));
    servers.push(server);
    const res = await fetch(`${url}/${encodeURIComponent("你好.js")}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("中文\n");
  });

  it("读取失败不抛 unhandled error", async () => {
    writeFileSync(path.join(staticDir, "app.js"), "x");
    const boom = new Readable({
      read() {
        this.destroy(new Error("boom"));
      },
    });
    vi.mocked(createReadStream).mockReturnValueOnce(boom as ReturnType<typeof createReadStream>);
    const { server, url } = await listen(makeContext(tmpDir, staticDir));
    servers.push(server);
    const parsed = new URL(url);
    await new Promise<void>((resolve) => {
      http
        .get({ host: parsed.hostname, port: parsed.port, path: "/app.js" }, (res) => {
          res.on("close", () => resolve());
          res.on("error", () => resolve());
          res.resume();
        })
        .on("error", () => resolve());
    });
    // 走到这里说明 error 被捕获、进程未因 unhandled error 崩溃
    expect(true).toBe(true);
  });
});
