import http from "node:http";

const clients = new Set();
const messages = [];
const history = [];
const sessions = [
  { file: "session_1.jsonl", mtime: Date.now(), preview: "历史会话" },
];

const traceFiles = ["2026-09-27"];

const traceEvents = {
  events: [
    { ts: 1000, type: "turn_start", sid: "session_1.jsonl", turn: 1, user_message: "查一下 trace 文件" },
    { ts: 1100, type: "llm", sid: "session_1.jsonl", turn: 1, model: "deepseek-chat" },
  ],
  nextCursor: 2,
};

const traceTurns = [
  {
    turn: 1,
    sid: "session_1.jsonl",
    userMessage: "查一下 trace 文件",
    startedAt: Date.now(),
    finished: false,
    cancelled: false,
    latencyMs: 2100,
    iterations: 1,
    toolsUsed: 1,
    costUsd: 0.001,
    events: [
      { ts: 1000, type: "turn_start", sid: "session_1.jsonl", turn: 1, user_message: "查一下 trace 文件" },
      { ts: 1100, type: "llm", sid: "session_1.jsonl", turn: 1, provider: "deepseek", model: "deepseek-chat", status: "ok", latency_ms: 80, usage: { promptTokens: 10, completionTokens: 5 } },
      { ts: 1200, type: "tool", sid: "session_1.jsonl", turn: 1, tool: "read_file", args_summary: "…", latency_ms: 20, status: "ok", output_summary: "file content" },
      { ts: 1300, type: "approval", sid: "session_1.jsonl", turn: 1, tool: "bash", decision: "allow", rule: "user", source: "web" },
    ],
  },
];

const traceOverview = {
  usage: {
    total: { in: 12000, out: 3000, costUsd: 0.42 },
    byDay: {
      "2026-09-26": { in: 4000, out: 1000, costUsd: 0.14 },
      "2026-09-27": { in: 8000, out: 2000, costUsd: 0.28 },
    },
    byProvider: { deepseek: { in: 12000, out: 3000, costUsd: 0.42 } },
    byModel: { "deepseek-chat": { in: 12000, out: 3000, costUsd: 0.42 } },
  },
  today: { turns: 3, tools: 5, avgLatencyMs: 1500 },
  recentTurns: [
    {
      turn: 3,
      sid: "session_1.jsonl",
      userMessage: "查一下 trace 文件",
      startedAt: Date.now(),
      finished: true,
      cancelled: false,
      latencyMs: 2100,
      iterations: 2,
      toolsUsed: 1,
      costUsd: 0.003,
      events: [],
    },
  ],
};

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
  if (method === "GET" && pathname === "/api/trace/files") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceFiles));
    return;
  }
  if (method === "GET" && pathname === "/api/trace/turns") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceTurns));
    return;
  }
  if (method === "GET" && pathname === "/api/trace/events") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceEvents));
    return;
  }
  if (method === "GET" && pathname === "/api/trace/overview") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceOverview));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(Number(process.env.MOCK_PORT ?? 8123), "127.0.0.1");
