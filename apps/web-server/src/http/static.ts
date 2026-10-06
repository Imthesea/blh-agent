import { createReadStream, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "./response.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  try {
    rel = decodeURIComponent(rel);
  } catch {
    sendJson(res, 400, { error: "bad path" });
    return;
  }
  const resolvedRoot = path.resolve(root);
  const file = path.normalize(path.join(resolvedRoot, rel));
  if (!file.startsWith(resolvedRoot + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const ext = path.extname(file);
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: "read failed" });
  });
  res.on("close", () => stream.destroy());
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  stream.pipe(res);
}
