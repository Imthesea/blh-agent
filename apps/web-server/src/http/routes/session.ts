import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  SessionIdResponse,
  SessionInfo,
  SessionListItem,
  SessionMessagesResponse,
} from "../../types.js";
import { readBody } from "../body.js";
import { sendJson } from "../response.js";
import type { WebContext } from "../context.js";

async function listSessions(
  workdir: string,
  sessionStore: WebContext["sessionStore"],
): Promise<SessionListItem[]> {
  const dir = sessionStore.sessionsDir(workdir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const result: SessionListItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const stats = statSync(file);
      if (!stats.isFile()) continue;
      const firstUser = await readFirstUser(file);
      result.push({
        file: name,
        mtime: stats.mtimeMs,
        preview: firstUser?.slice(0, 80) ?? "",
      });
    } catch {
    }
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

async function readFirstUser(file: string): Promise<string | null> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as {
          type?: unknown;
          message?: { role?: unknown; content?: unknown };
          role?: unknown;
          content?: unknown;
        };
        // 新事件格式：message 事件把消息嵌在 .message 里；旧格式是裸消息行。
        const message = entry.type === "message" && entry.message ? entry.message : entry;
        if (message.role === "user") {
          return typeof message.content === "string" ? message.content : "";
        }
      } catch {
      }
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebContext,
  method: string,
  pathname: string,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/session") {
    const handle = ctx.session.list()[0];
    if (handle === undefined) {
      const response: SessionInfo = { sessionId: null, messages: [], workdir: ctx.workdir };
      sendJson(res, 200, response);
      return true;
    }
    const response: SessionInfo = {
      sessionId: handle.id,
      workdir: ctx.workdir,
      messages: [...handle.transcript.messagesWithIds],
    };
    sendJson(res, 200, response);
    return true;
  }

  if (method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, { sessions: await listSessions(ctx.workdir, ctx.sessionStore) });
    return true;
  }

  const sessionMatch = /^\/api\/sessions\/(.+)$/.exec(pathname);
  if (method === "GET" && sessionMatch !== null) {
    let file: string;
    try {
      file = decodeURIComponent(sessionMatch[1] ?? "");
    } catch {
      sendJson(res, 400, { error: "invalid session file" });
      return true;
    }
    if (path.basename(file) !== file || file === "." || file === "..") {
      sendJson(res, 400, { error: "invalid session file" });
      return true;
    }
    const filePath = path.join(ctx.sessionStore.sessionsDir(ctx.workdir), file);
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    try {
      const messages = ctx.sessionStore.loadMessages(filePath);
      const response: SessionMessagesResponse = { file, messages };
      sendJson(res, 200, response);
    } catch {
      sendJson(res, 500, { error: "failed to load session" });
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/session/new") {
    const handle = await ctx.session.create(ctx.workdir);
    const response: SessionIdResponse = { sessionId: handle.id };
    sendJson(res, 200, response);
    return true;
  }

  if (method === "POST" && pathname === "/api/session/resume") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const file = typeof body.file === "string" ? body.file : "";
    if (file === "") {
      sendJson(res, 400, { error: "file is required" });
      return true;
    }
    if (path.basename(file) !== file || file === "." || file === "..") {
      sendJson(res, 400, { error: "invalid session file" });
      return true;
    }
    const handle = await ctx.session.resume(ctx.workdir, file);
    const response: SessionIdResponse = { sessionId: handle.id };
    sendJson(res, 200, response);
    return true;
  }

  if (method === "POST" && pathname === "/api/session/delete") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const file = typeof body.file === "string" ? body.file : "";
    if (file === "") {
      sendJson(res, 400, { error: "file is required" });
      return true;
    }
    if (path.basename(file) !== file || file === "." || file === "..") {
      sendJson(res, 400, { error: "invalid session file" });
      return true;
    }
    await ctx.session.remove(ctx.workdir, file);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
