/** /api/trace/* 只读端点路由（全部 GET；本地 sendJson 避免与 http.ts 循环导入）。 */
import type { ServerResponse } from "node:http";
import type { WebContext } from "./http.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 处理 /api/trace/* 请求；在 CSRF 检查之前挂载（全部为只读 GET，非 GET 一律 405）。 */
export function handleTraceApi(res: ServerResponse, ctx: WebContext, method: string, url: URL): void {
  const trace = ctx.trace;
  if (trace === undefined) {
    sendJson(res, 404, { error: "trace not available" });
    return;
  }
  if (method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  const date = url.searchParams.get("date") ?? undefined;
  if (date !== undefined && !DATE_RE.test(date)) {
    sendJson(res, 400, { error: "invalid date" });
    return;
  }
  switch (url.pathname) {
    case "/api/trace/overview":
      sendJson(res, 200, trace.overview());
      return;
    case "/api/trace/turns": {
      const sid = url.searchParams.get("sid");
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw !== null ? Number(limitRaw) : NaN;
      sendJson(res, 200, trace.turns({
        ...(date !== undefined ? { date } : {}),
        ...(sid !== null && sid !== "" ? { sid } : {}),
        ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      }));
      return;
    }
    case "/api/trace/events": {
      // tail=N：返回文件尾部 N 行（新连接从尾部开始，不回放全量历史）
      const tailRaw = url.searchParams.get("tail");
      if (tailRaw !== null) {
        const tail = Number(tailRaw);
        if (!Number.isInteger(tail) || tail <= 0) {
          sendJson(res, 400, { error: "invalid tail" });
          return;
        }
        const total = trace.events(Number.MAX_SAFE_INTEGER, date).nextCursor;
        sendJson(res, 200, trace.events(Math.max(0, total - tail), date));
        return;
      }
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      if (!Number.isInteger(cursor) || cursor < 0) {
        sendJson(res, 400, { error: "invalid cursor" });
        return;
      }
      sendJson(res, 200, trace.events(cursor, date));
      return;
    }
    case "/api/trace/files":
      sendJson(res, 200, trace.files());
      return;
    default:
      sendJson(res, 404, { error: "not found" });
  }
}
