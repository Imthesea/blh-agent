import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@blh/logger";
import { readBody } from "../body.js";
import { sendJson } from "../response.js";
import type { WebContext } from "../context.js";

const log = createLogger("web-server.http");

export async function handleMessageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebContext,
  method: string,
  pathname: string,
): Promise<boolean> {
  if (method === "POST" && pathname === "/api/message") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") {
      sendJson(res, 400, { error: "text is required" });
      return true;
    }
    // 无活跃会话时惰性新建（维持「始终有活跃会话」不变量），避免首次发送被 400 拒绝。
    const handle = ctx.session.list()[0] ?? (await ctx.session.create(ctx.workdir));
    ctx.session.runTurn(handle.id, text).catch((error: unknown) => {
      log.error("run turn failed", { id: handle.id }, error);
      ctx.broadcaster.broadcast({
        type: "agent_error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    sendJson(res, 202, { accepted: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/stop") {
    ctx.session.stop();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
