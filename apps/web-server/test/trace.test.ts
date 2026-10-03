import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createWebServer, type WebContext } from "../src/http.js";
import { SSEBroadcaster } from "../src/bridge.js";
import { SessionManager } from "../src/session.js";
import { ApprovalCoordinator } from "../src/approval.js";
import type { TraceModule, TurnLock, WebTurnRunner } from "../src/types.js";
import { makeTestSessionStore } from "./helpers.js";

async function makeContext(workdir: string, trace?: TraceModule): Promise<WebContext> {
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
  return { session, broadcaster, workdir, staticDir: null, sessionStore, ...(trace !== undefined ? { trace } : {}) };
}

async function listen(ctx: WebContext | Promise<WebContext>): Promise<{ server: Server; url: string }> {
  const server = createWebServer(await ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

const stubTrace: TraceModule = {
  overview: () => ({ totalTurns: 3 }),
  turns: (opts) => ({ turns: [], opts: opts ?? null }),
  events: (cursor, date) => ({ events: [], cursor, nextCursor: cursor, date: date ?? null }),
  files: () => ({ files: ["2026-09-27.jsonl"] }),
};

describe("trace api", () => {
  let tmpDir: string;
  let servers: Server[] = [];
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-trace-"));
  });
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/trace/overview 返回模块数据", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/overview`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ totalTurns: 3 });
  });

  it("未注入 trace 时返回 404", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/overview`);
    expect(res.status).toBe(404);
  });

  it("非 GET 返回 405", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/overview`, { method: "POST", headers: { "x-blh-web": "1" } });
    expect(res.status).toBe(405);
  });

  it("非法 date 返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/turns?date=09-27`);
    expect(res.status).toBe(400);
  });

  it("events 透传 cursor 与 date", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/events?cursor=5&date=2026-09-27`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], cursor: 5, nextCursor: 5, date: "2026-09-27" });
  });

  it("非法 cursor 返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/events?cursor=-1`);
    expect(res.status).toBe(400);
  });
});
