import type { IncomingMessage, ServerResponse } from "node:http";
import { appendRawEntry, createLogger, isLogLevel } from "@blh/logger";
import { readBody } from "../body.js";
import { sendJson } from "../response.js";
import type { WebContext } from "../context.js";

const MAX_LOG_MESSAGE = 10_000;
const MAX_LOG_FIELDS_BYTES = 10_000;
const MAX_LOG_MODULE = 256;
const log = createLogger("web-server.http");

export async function handleLogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: WebContext,
  method: string,
  pathname: string,
): Promise<boolean> {
  if (method !== "POST" || pathname !== "/api/log") return false;

  const rawBody = await readBody(req);
  if (typeof rawBody !== "object" || rawBody === null) {
    sendJson(res, 400, { error: "entries is required" });
    return true;
  }
  const entries = (rawBody as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) {
    sendJson(res, 400, { error: "entries is required" });
    return true;
  }
  const bounded = entries.slice(0, 1000);
  for (const raw of bounded) {
    const entry = raw as Record<string, unknown>;
    const level = entry.level;
    if (!isLogLevel(level)) continue;
    const message = typeof entry.message === "string" ? entry.message.slice(0, MAX_LOG_MESSAGE) : "";
    const moduleName = typeof entry.module === "string" ? entry.module.slice(0, MAX_LOG_MODULE) : "web";
    const parsed = new Date(typeof entry.time === "string" ? entry.time : Date.now());
    const time = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    let fields =
      typeof entry.fields === "object" && entry.fields !== null
        ? (entry.fields as Record<string, unknown>)
        : {};
    if (JSON.stringify(fields).length > MAX_LOG_FIELDS_BYTES) {
      fields = { truncated: true };
    }
    appendRawEntry({ time, level, module: moduleName, message, fields });
  }
  log.debug("frontend logs received", { count: bounded.length });
  sendJson(res, 202, { accepted: true });
  return true;
}
