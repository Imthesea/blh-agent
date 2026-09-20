import http from "node:http";

const clients = new Set();
const messages = [];
const history = [];
const sessions = [
  { file: "session_1.jsonl", mtime: Date.now(), preview: "历史会话" },
];

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  // 回放最近事件，避免连接建立前广播的事件因 SSE 无重放而丢失
  for (const ev of history) res.write(frame(ev.type, ev.data));
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function frame(type, data = {}) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(type, data) {
  history.push({ type, data });
  if (history.length > 100) history.shift();
  const f = frame(type, data);
  for (const c of clients) c.write(f);
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/events") {
    sse(res);
    return;
  }
  if (method === "GET" && pathname === "/api/session") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId: "test", workdir: "/tmp", messages }));
    return;
  }
  if (method === "GET" && pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }
  if (method === "POST" && pathname === "/api/message") {
    const body = await readJson(req);
    const text = (body.text ?? "").toString();
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true }));
    messages.push({ role: "user", content: text });

    if (text.includes("工具")) {
      broadcast("turn_start");
      broadcast("tool_call", { id: "t1", name: "read_file", arguments: "{}" });
      broadcast("tool_result", {
        id: "t1",
        name: "read_file",
        output: "file content",
        isError: false,
      });
      // 不广播 turn_end，保持工具卡片可见供 e2e 断言
    } else if (text.includes("审批")) {
      broadcast("turn_start");
      broadcast("approval_requested", {
        requestId: "approval_1",
        tool: "bash",
        target: "rm -rf /",
        args: { cmd: "rm -rf /" },
      });
    } else if (text.includes("错误")) {
      broadcast("turn_start");
      broadcast("agent_error", { message: "模拟错误" });
    } else if (text.includes("中断")) {
      broadcast("turn_start");
      broadcast("assistant_text_delta", { text: "你好" });
      // 不广播 turn_end，保持 busy，让前端显示「停止」按钮
    } else {
      broadcast("turn_start");
      broadcast("assistant_text_delta", { text: "你好，世界" });
      messages.push({ role: "assistant", content: "你好，世界" });
      broadcast("turn_end");
    }
    return;
  }
  if (method === "POST" && pathname === "/api/stop") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    messages.push({ role: "assistant", content: "你好", cancelled: true });
    broadcast("turn_cancelled", { text: "你好" });
    return;
  }
  if (method === "POST" && pathname === "/api/approval") {
    await readJson(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    broadcast("turn_end");
    return;
  }
  if (method === "POST" && pathname === "/api/session/delete") {
    const body = await readJson(req);
    const file = (body.file ?? "").toString();
    const idx = sessions.findIndex((s) => s.file === file);
    if (idx >= 0) sessions.splice(idx, 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (method === "POST" && pathname === "/api/__reset") {
    messages.length = 0;
    history.length = 0;
    sessions.splice(0, sessions.length, { file: "session_1.jsonl", mtime: Date.now(), preview: "历史会话" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(8123, "127.0.0.1");
