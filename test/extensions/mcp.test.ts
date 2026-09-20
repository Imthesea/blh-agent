import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { MCPClient, MCPRegistry, normalizeMcpName } from "../../src/extensions/mcp.js";
import { HttpTransport, StdioTransport } from "../../src/extensions/mcp-transport.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const SERVER_CODE = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
const TOOLS = [
  { name: "search", description: "Search docs.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const method = req.method;
  if (method === "server/discover") {
    reply(req.id, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
  } else if (method === "tools/list") {
    reply(req.id, { resultType: "complete", tools: TOOLS });
  } else if (method === "tools/call") {
    const params = req.params;
    if (params.name !== "search") {
      reply(req.id, { resultType: "complete", content: [{ type: "text", text: "unknown tool: " + params.name }], isError: true });
    } else {
      reply(req.id, { resultType: "complete", content: [{ type: "text", text: "searched " + (params.arguments.query ?? "") }], isError: false });
    }
  } else {
    reply(req.id, { resultType: "complete", content: [], isError: false });
  }
});
`;

const LEGACY_SERVER_CODE = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}
const TOOLS = [
  { name: "search", description: "Search docs.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const method = req.method;
  if (method === "server/discover") {
    replyError(req.id, -32601, "Method not found");
  } else if (method === "initialize") {
    if (req.params && req.params._meta) {
      replyError(req.id, -32602, "unexpected _meta in initialize");
    } else {
      reply(req.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1.0.0" } });
    }
  } else if (method === "tools/list") {
    if (req.params && req.params._meta) {
      replyError(req.id, -32602, "unexpected _meta in tools/list");
    } else {
      reply(req.id, { tools: TOOLS });
    }
  } else if (method === "tools/call") {
    const query = req.params.arguments.query ?? "";
    reply(req.id, { content: [{ type: "text", text: "searched " + query }], isError: false });
  } else {
    replyError(req.id, -32601, "Method not found");
  }
});
`;

const LEGACY_TIMEOUT_SERVER_CODE = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
const TOOLS = [
  { name: "search", description: "Search docs.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const method = req.method;
  if (method === "server/discover") {
    // 故意不回复，模拟旧服务器对未知方法沉默
  } else if (method === "initialize") {
    reply(req.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1.0.0" } });
  } else if (method === "tools/list") {
    reply(req.id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const query = req.params.arguments.query ?? "";
    reply(req.id, { content: [{ type: "text", text: "searched " + query }], isError: false });
  } else {
    reply(req.id, {});
  }
});
`;

const UNSUPPORTED_SERVER_CODE = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "server/discover") {
    replyError(req.id, -32022, "Unsupported protocol version");
  } else {
    replyError(req.id, -32601, "Method not found");
  }
});
`;

function startClient(): MCPClient {
  return new MCPClient("fake", new StdioTransport(process.execPath, ["-e", SERVER_CODE], "fake"));
}

// ---- HTTP 测试辅助 ----

// 读一个 HTTP 请求的 body，解析成 JSON 对象。
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

// 在本地起一个 HTTP 服务器，返回它的 URL 和关闭函数。
function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("unexpected server address");
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const HTTP_TOOLS = [
  {
    name: "search",
    description: "Search hotels.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

// 模拟一个「新版协议」的 streamable-http 服务器。
function modernHttpHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const body = await readBody(req);
    const id = body.id as number;
    const method = body.method as string;
    let result: unknown;
    if (method === "server/discover") {
      result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
    } else if (method === "tools/list") {
      result = { tools: HTTP_TOOLS };
    } else if (method === "tools/call") {
      const args = (body.params as { arguments?: { query?: string } }).arguments ?? {};
      result = { content: [{ type: "text", text: "searched " + (args.query ?? "") }], isError: false };
    } else {
      result = { content: [], isError: false };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
}

// 模拟一个「旧版协议」的 streamable-http 服务器：discover 报 -32601，走 initialize 握手，并带会话 id。
function legacyHttpHandler(opts?: { onRequest?: (headers: IncomingMessage["headers"], body: Record<string, unknown>) => void }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    opts?.onRequest?.(req.headers, body);
    const id = body.id as number | undefined;
    const method = body.method as string;
    // 通知（无 id）返回 202 无 body。
    if (typeof id !== "number") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (method === "server/discover") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
      return;
    }
    if (method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-123" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy-http", version: "1.0.0" } },
        }),
      );
      return;
    }
    if (method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: HTTP_TOOLS } }));
      return;
    }
    if (method === "tools/call") {
      const args = (body.params as { arguments?: { query?: string } }).arguments ?? {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "searched " + (args.query ?? "") }], isError: false } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
  };
}

describe("MCPClient", () => {
  it("discover_and_list_tools", async () => {
    const client = startClient();
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search"]);
    } finally {
      await client.close();
    }
  });

  it("call_tool", async () => {
    const client = startClient();
    try {
      await client.start();
      expect(await client.callTool("search", { query: "x" })).toBe("searched x");
    } finally {
      await client.close();
    }
  });

  it("call_unknown_tool", async () => {
    const client = startClient();
    try {
      await client.start();
      expect(await client.callTool("nope", {})).toContain("unknown tool");
    } finally {
      await client.close();
    }
  });

  it("start_rejects_when_command_does_not_exist", async () => {
    const client = new MCPClient("x", new StdioTransport("definitely-not-a-real-cmd-xyz"));
    await expect(client.start()).rejects.toThrow();
  });

  it("start_rejects_when_server_exits_immediately", async () => {
    const client = new MCPClient(
      "x",
      new StdioTransport(process.execPath, ["-e", "process.exit(1)"], "x"),
      2000,
    );
    await expect(client.start()).rejects.toThrow();
  });

  it("start_falls_back_to_initialize_for_legacy_server", async () => {
    const client = new MCPClient(
      "legacy",
      new StdioTransport(process.execPath, ["-e", LEGACY_SERVER_CODE], "legacy"),
    );
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search"]);
      expect(await client.callTool("search", { query: "x" })).toBe("searched x");
    } finally {
      await client.close();
    }
  });

  it("start_falls_back_when_discover_times_out", async () => {
    const client = new MCPClient(
      "legacy-timeout",
      new StdioTransport(process.execPath, ["-e", LEGACY_TIMEOUT_SERVER_CODE], "legacy-timeout"),
      30000,
      50,
    );
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search"]);
    } finally {
      await client.close();
    }
  });

  it("start_rejects_when_modern_server_unsupported_version", async () => {
    const client = new MCPClient(
      "modern-unsupported",
      new StdioTransport(process.execPath, ["-e", UNSUPPORTED_SERVER_CODE], "modern-unsupported"),
    );
    try {
      await expect(client.start()).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

describe("MCPClient over HTTP", () => {
  it("http_discover_and_list_tools", async () => {
    const server = await startHttpServer(modernHttpHandler());
    const client = new MCPClient("http-fake", new HttpTransport(server.url));
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search"]);
      expect(await client.callTool("search", { query: "hotel" })).toBe("searched hotel");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("http_falls_back_to_initialize_for_legacy_server", async () => {
    const server = await startHttpServer(legacyHttpHandler());
    const client = new MCPClient("http-legacy", new HttpTransport(server.url));
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search"]);
      expect(await client.callTool("search", { query: "x" })).toBe("searched x");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("http_passes_auth_headers", async () => {
    let seenAuth: string | undefined;
    const server = await startHttpServer(
      legacyHttpHandler({
        onRequest: (headers) => {
          seenAuth = headers.authorization;
        },
      }),
    );
    const client = new MCPClient(
      "http-auth",
      new HttpTransport(server.url, { Authorization: "Bearer mcp_secret" }),
    );
    try {
      await client.start();
      await client.listTools();
    } finally {
      await client.close();
      await server.close();
    }
    expect(seenAuth).toBe("Bearer mcp_secret");
  });

  it("http_passes_session_id_after_initialize", async () => {
    const seenSessionIds: (string | undefined)[] = [];
    const server = await startHttpServer(
      legacyHttpHandler({
        onRequest: (headers) => {
          const sid = headers["mcp-session-id"];
          seenSessionIds.push(typeof sid === "string" ? sid : undefined);
        },
      }),
    );
    const client = new MCPClient("http-session", new HttpTransport(server.url));
    try {
      await client.start();
      await client.listTools();
    } finally {
      await client.close();
      await server.close();
    }
    // initialize 之后的请求（tools/list）应该带上会话 id。
    expect(seenSessionIds).toContain("sess-123");
  });

  it("http_parses_sse_response", async () => {
    const server = await startHttpServer(async (req, res) => {
      const body = await readBody(req);
      const id = body.id as number;
      const method = body.method as string;
      if (method === "server/discover") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } }));
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: HTTP_TOOLS } }));
        return;
      }
      // tools/call 用 SSE 流返回结果。
      if (method === "tools/call") {
        const payload = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "sse result" }], isError: false } };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(payload)}\n\n`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [], isError: false } }));
    });
    const client = new MCPClient("http-sse", new HttpTransport(server.url));
    try {
      await client.start();
      expect(await client.callTool("search", { query: "x" })).toBe("sse result");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("http_reports_http_error", async () => {
    const server = await startHttpServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized" } }));
    });
    const client = new MCPClient("http-401", new HttpTransport(server.url));
    try {
      await expect(client.start()).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("normalizeMcpName", () => {
  it("normalize_mcp_name", () => {
    expect(normalizeMcpName("docs.one/get")).toBe("docs_one_get");
  });

  it("normalize_mcp_name_empty_raises", () => {
    expect(() => normalizeMcpName("")).toThrow();
  });
});

describe("MCPRegistry", () => {
  it("connect_registers_prefixed_tools", async () => {
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    const result = await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE]);
    expect(result).toContain("fake");
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("mcp__fake__search");
  });

  it("connect_duplicate_returns_message", async () => {
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE]);
    expect(await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE])).toContain(
      "already connected",
    );
  });

  it("connect_http_registers_prefixed_tools", async () => {
    const server = await startHttpServer(modernHttpHandler());
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    const result = await mcp.connectHttp("hotel", server.url);
    try {
      expect(result).toContain("hotel");
      expect(registry.list().map((t) => t.name)).toContain("mcp__hotel__search");
    } finally {
      await server.close();
    }
  });

  it("system_prompt_section", async () => {
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    expect(mcp.systemPromptSection()).toBe("");
    await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE]);
    expect(mcp.systemPromptSection()).toContain("fake");
  });

  it("connect_rolls_back_on_tool_name_too_long", async () => {
    const longName = "x".repeat(60);
    const code = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
const TOOLS = [
  { name: "search", description: "s", inputSchema: { type: "object", properties: {} } },
  { name: "${longName}", description: "long", inputSchema: { type: "object", properties: {} } },
];
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "server/discover") reply(req.id, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
  else if (req.method === "tools/list") reply(req.id, { resultType: "complete", tools: TOOLS });
  else reply(req.id, { resultType: "complete", content: [], isError: false });
});
`;
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    const result = await mcp.connect("fake", process.execPath, ["-e", code]);
    expect(result).toContain("tool name too long");
    expect(registry.list().filter((t) => t.name.startsWith("mcp__"))).toEqual([]);
  });
});
