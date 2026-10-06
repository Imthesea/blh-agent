import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalDecision } from "../../types.js";
import { readBody } from "../body.js";
import { sendJson } from "../response.js";
import type { WebContext } from "../context.js";

export async function handleApprovalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebContext,
  method: string,
  pathname: string,
): Promise<boolean> {
  if (method !== "POST" || pathname !== "/api/approval") return false;

  const body = (await readBody(req)) as Record<string, unknown>;
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const decision = body.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "always_allow") {
    sendJson(res, 400, { error: "invalid decision" });
    return true;
  }
  const ok = ctx.session.approve(requestId, decision as ApprovalDecision);
  sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "unknown requestId" });
  return true;
}
