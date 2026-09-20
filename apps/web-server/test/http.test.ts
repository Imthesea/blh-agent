import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebServer, type WebContext } from "../src/http.js";
import { SSEBroadcaster } from "../src/bridge.js";
import { SessionManager } from "../src/session.js";
import { ApprovalCoordinator } from "../src/approval.js";
import type { TurnLock, WebTurnRunner } from "../src/types.js";
import type { Server } from "node:http";
import { makeTestSessionStore } from "./helpers.js";

function makeContext(workdir: string): WebContext {
  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));
  const runner: WebTurnRunner = {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: async (messages, text) => {
      messages.push({ role: "user", content: text });
      messages.push({ role: "assistant", content: `reply:${text}` });
    },
  };
  const lock: TurnLock = { withLock: async <T,>(fn: () => Promise<T>) => fn() };
  const sessionStore = makeTestSessionStore();
  const session = new SessionManager(runner, lock, (event) => broadcaster.broadcast(event), approvals, sessionStore);
  session.create(workdir);
  return { session, broadcaster, workdir, staticDir: null, sessionStore };
}

async function listen(ctx: WebContext): Promise<{ server: Server; url: string }> {
  const server = createWebServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

let servers: Server[] = [];
let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-http-"));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("http 路由", () => {
  it("GET /api/session 返回当前会话", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workdir: string; messages: unknown[] };
    expect(body.workdir).toBe(tmpDir);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("POST /api/message 返回 202 并写入会话", async () => {
    const ctx = makeContext(tmpDir);
    const { server, url } = await listen(ctx);
    servers.push(server);
    const res = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const s = (await (await fetch(`${url}/api/session`)).json()) as {
      messages: Array<{ content: string | null }>;
    };
    expect(s.messages.map((m: { content: string | null }) => m.content)).toContain("reply:hi");
  });

  it("POST /api/message 缺少 CSRF 头返回 403", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/message 空文本返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/approval 非法 decision 返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ requestId: "x", decision: "maybe" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/approval 未知 id 返回 404", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ requestId: "nope", decision: "allow" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/sessions 返回列表", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("GET /api/events 返回 SSE 头", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const parsed = new URL(url);
    await new Promise<void>((resolve, reject) => {
      http
        .get({ host: parsed.hostname, port: parsed.port, path: "/api/events" }, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");
          res.destroy();
          resolve();
        })
        .on("error", reject);
    });
  });

  it("伪造 Host 返回 403", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const parsed = new URL(url);
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          { host: parsed.hostname, port: parsed.port, path: "/api/session", headers: { Host: "evil.com" } },
          (res) => {
            expect(res.statusCode).toBe(403);
            res.resume();
            resolve();
          },
        )
        .on("error", reject);
    });
  });

  it("合法 localhost Host 正常访问", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const parsed = new URL(url);
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          { host: parsed.hostname, port: parsed.port, path: "/api/session", headers: { Host: `localhost:${parsed.port}` } },
          (res) => {
            expect(res.statusCode).toBe(200);
            res.resume();
            resolve();
          },
        )
        .on("error", reject);
    });
  });

  it("GET /api/sessions/.. 拒绝路径穿越", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/sessions/%2e%2e%2fetc%2fpasswd`);
    expect(res.status).toBe(400);
  });

  it("POST /api/message 非法 JSON body 返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/session/resume 拒绝点号目录", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/session/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ file: ".." }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/session/delete 删除会话文件", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const sessionsDir = path.join(tmpDir, ".sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const target = path.join(sessionsDir, "session_del.jsonl");
    writeFileSync(target, JSON.stringify({ role: "user", content: "x" }) + "\n");
    const res = await fetch(`${url}/api/session/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ file: "session_del.jsonl" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(target)).toBe(false);
  });

  it("POST /api/session/delete 拒绝路径穿越", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/session/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ file: ".." }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions/:file 成功返回消息", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const sessionsDir = path.join(tmpDir, ".sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(path.join(sessionsDir, "session_test.jsonl"), JSON.stringify({ role: "user", content: "hi" }) + "\n");
    const res = await fetch(`${url}/api/sessions/session_test.jsonl`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ content: string | null }> };
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("GET /api/sessions/:file 不存在返回 404", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/sessions/nope.jsonl`);
    expect(res.status).toBe(404);
  });

  it("Content-Length 超限返回 413", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const parsed = new URL(url);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: parsed.hostname,
          port: parsed.port,
          path: "/api/message",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-blh-web": "1",
            "Content-Length": String(1024 * 1024 + 1),
          },
        },
        (res) => {
          expect(res.statusCode).toBe(413);
          res.resume();
          resolve();
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ text: "hi" }));
    });
  });

  it("POST /api/stop 返回 200 ok", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/stop`, { method: "POST", headers: { "x-blh-web": "1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /api/stop 缺少 CSRF 头返回 403", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/stop`, { method: "POST" });
    expect(res.status).toBe(403);
  });
});
