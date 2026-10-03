import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLogger, resetLogger } from "@blh/logger";
import { createWebServer, type WebContext } from "../src/http.js";
import { SSEBroadcaster } from "../src/bridge.js";
import { SessionManager } from "../src/session.js";
import { ApprovalCoordinator } from "../src/approval.js";
import type { TurnLock, WebTurnRunner } from "../src/types.js";
import { makeTestSessionStore } from "./helpers.js";

async function makeContext(workdir: string): Promise<WebContext> {
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
  return { session, broadcaster, workdir, staticDir: null, sessionStore };
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
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-log-"));
  initLogger(tmpDir, "info");
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  resetLogger();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/log", () => {
  it("落盘前端日志", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({
        entries: [
          { time: "2026-09-18T08:00:00.000Z", level: "info", module: "web.app", message: "hello", fields: {} },
        ],
      }),
    });
    expect(res.status).toBe(202);
    const logsDir = path.join(tmpDir, ".blh", "logs");
    const files = readdirSync(logsDir);
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(path.join(logsDir, files[0]!), "utf8");
    expect(content).toContain("web.app");
  });

  it("缺少 CSRF 头返回 403", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("entries 非数组返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ entries: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});
