import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createLogger } from "@blh/logger";
import { CSRF_HEADER, isLocalHost } from "./security.js";
import { HttpError, sendJson } from "./response.js";
import { serveStatic } from "./static.js";
import type { WebContext } from "./context.js";
import { handleApprovalRoutes } from "./routes/approval.js";
import { handleLogRoutes } from "./routes/log.js";
import { handleMessageRoutes } from "./routes/message.js";
import { handleSessionRoutes } from "./routes/session.js";
import { handleTraceApi } from "./routes/trace.js";

const log = createLogger("web-server.http");

export interface WebHttpServer extends Server {
  stopAcceptingRequests(): Promise<void>;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebContext,
  method: string,
  pathname: string,
): Promise<void> {
  if (pathname.startsWith("/api/trace/")) {
    handleTraceApi(res, ctx, method, new URL(req.url ?? "/", "http://127.0.0.1"));
    return;
  }
  if (method !== "GET" && method !== "HEAD" && req.headers[CSRF_HEADER] !== "1") {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  log.debug("request", { method, pathname });

  const handled =
    (await handleSessionRoutes(req, res, ctx, method, pathname)) ||
    (await handleMessageRoutes(req, res, ctx, method, pathname)) ||
    (await handleLogRoutes(req, res, ctx, method, pathname)) ||
    (await handleApprovalRoutes(req, res, ctx, method, pathname));
  if (!handled) sendJson(res, 404, { error: "not found" });
}

export function createWebServer(ctx: WebContext): WebHttpServer {
  let acceptingRequests = true;
  let stopPromise: Promise<void> | null = null;
  const server = createHttpServer((req, res) => {
    void (async () => {
      if (!acceptingRequests) {
        sendJson(res, 503, { error: "server is shutting down" });
        return;
      }
      if (!isLocalHost(req.headers.host)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/api/events") {
        const off = ctx.broadcaster.subscribe(res);
        res.on("close", off);
        return;
      }
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, ctx, method, pathname);
        return;
      }
      if (ctx.staticDir === null) {
        sendJson(res, 404, { error: "not found (dev mode: use Vite dev server)" });
        return;
      }
      serveStatic(res, ctx.staticDir, pathname);
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      sendJson(res, 500, { error: "internal error" });
    });
  });
  return Object.assign(server, {
    stopAcceptingRequests(): Promise<void> {
      stopPromise ??= new Promise<void>((resolve, reject) => {
        acceptingRequests = false;
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return stopPromise;
    },
  });
}
