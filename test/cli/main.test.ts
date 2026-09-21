import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// —— 启动时自动连接 MCP 的 HTTP 测试辅助 ——

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
      if (addr === null || typeof addr === "string") throw new Error("unexpected server address");
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// 模拟新版协议 HTTP MCP 服务器：discover 支持 2026-07-28，tools/list 返回一个 search 工具。
function modernHttpHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const body = await readBody(req);
    const id = body.id as number;
    const method = body.method as string;
    let result: unknown;
    if (method === "server/discover") {
      result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
    } else if (method === "tools/list") {
      result = {
        tools: [
          { name: "search", description: "Search.", inputSchema: { type: "object", properties: {} } },
        ],
      };
    } else {
      result = {};
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
}

describe("buildHarness 装配", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cli-main-"));
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "k";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compactor 与 compact 工具就位", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.compactor?.toolResultsDir).toBe(
      path.join(tmpDir, ".task_outputs", "tool-results"),
    );
    expect(harness.tools.list().map((tool) => tool.name)).toContain("compact");
  });

  it("planning 工具与 todoManager 就位", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.todoManager).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    for (const name of [
      "todo_write", "create_task", "update_task", "list_tasks",
      "get_task", "claim_task", "complete_task",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("memory 装配到 .memory 目录", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.memory).toBeDefined();
    expect(harness.memory?.store.directory).toBe(path.join(tmpDir, ".memory"));
  });

  it("jobs 装配到 scheduled_tasks.json 与三个 cron 工具", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.jobs).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    for (const name of ["schedule_cron", "list_crons", "cancel_cron"]) {
      expect(names).toContain(name);
    }
  });

  it("cron 持久化任务在 buildHarness 时被加载", async () => {
    writeFileSync(
      path.join(tmpDir, ".scheduled_tasks.json"),
      JSON.stringify([
        {
          id: "cron_test1",
          cron: "* * * * *",
          prompt: "hi",
          recurring: true,
          durable: true,
          pending_delivery: false,
          last_fired: null,
        },
      ]),
    );
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.jobs?.cron.listJobs().map((job) => job.id)).toContain("cron_test1");
  });

  it("buildHarness wires agents", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.agents).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    for (const name of [
      "task", "spawn_teammate", "list_teammates", "send_message",
      "request_shutdown", "request_plan", "review_plan", "create_worktree",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("buildHarness wires extensions", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.extensions).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    expect(names).toContain("load_skill");
    expect(names).toContain("connect_mcp");
  });

  it("buildHarness wires workflow and goal", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.goal).toBeDefined();
    expect(harness.workflow).toBe(path.join(tmpDir, ".workflow_runtime"));
    expect(harness.tools.list().map((tool) => tool.name)).toContain("run_workflow");
  });

  it("启动时自动连接配置文件里声明的 HTTP MCP 服务器", async () => {
    const originalCwd = process.cwd();
    const server = await startHttpServer(modernHttpHandler());
    try {
      process.chdir(tmpDir);
      writeFileSync(
        path.join(tmpDir, ".blh.yaml"),
        ["mcp_servers:", "  - name: fakehttp", `    url: ${server.url}`, ""].join("\n"),
      );
      const { buildHarness } = await import("../../src/cli/main.js");
      const harness = buildHarness(tmpDir);
      // 连接是后台异步进行的，轮询等待工具注册完成。
      const toolName = "mcp__fakehttp__search";
      const deadline = Date.now() + 8000;
      while (!harness.tools.list().some((tool) => tool.name === toolName)) {
        if (Date.now() > deadline) throw new Error("MCP 工具未在超时内自动注册");
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(harness.tools.list().map((tool) => tool.name)).toContain(toolName);
    } finally {
      await server.close();
      process.chdir(originalCwd);
    }
  });
});

describe("parseCliArgs", () => {
  it("parses model and base-url flags", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs([
      "--model", "deepseek-chat",
      "--base-url", "https://example.com/v1",
    ]);
    expect(parsed.cli.model).toBe("deepseek-chat");
    expect(parsed.cli.base_url).toBe("https://example.com/v1");
    expect(parsed.prompt).toBeUndefined();
    expect(parsed.workdir).toBeUndefined();
  });

  it("parses workdir/timeout/max-output flags", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs([
      "--workdir", "C:\\tmp\\work",
      "--bash-timeout", "60",
      "--max-output-chars", "1000",
    ]);
    expect(parsed.workdir).toBe("C:\\tmp\\work");
    expect(parsed.cli.workdir).toBe("C:\\tmp\\work");
    expect(parsed.cli.bash_timeout).toBe("60");
    expect(parsed.cli.max_output_chars).toBe("1000");
  });

  it("parses -p prompt", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["-p", "你好，世界"]);
    expect(parsed.prompt).toBe("你好，世界");
    expect(parsed.cli).toEqual({});
  });

  it("parses --dangerously-skip-permissions flag", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    expect(parseCliArgs([]).skipPermissions).toBeUndefined();
    expect(parseCliArgs(["--dangerously-skip-permissions"]).skipPermissions).toBe(true);
  });

  it("parses --continue with no value (restore latest)", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["--continue"]);
    expect(parsed.continue).toBe(true);
    expect(parsed.continueFile).toBeUndefined();
  });

  it("parses --continue <file>", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["--continue", "session_123.jsonl"]);
    expect(parsed.continue).toBe(true);
    expect(parsed.continueFile).toBe("session_123.jsonl");
  });

  it("no --continue leaves continue flags unset", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["-p", "hi"]);
    expect(parsed.continue).toBeUndefined();
    expect(parsed.continueFile).toBeUndefined();
  });

  it("解析 web 子命令与 --port/--dev", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["web", "--port", "9000", "--dev"]);
    expect(parsed.web).toBe(true);
    expect(parsed.port).toBe(9000);
    expect(parsed.dev).toBe(true);
  });

  it("无 web 子命令时不带 web/port/dev 标记", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["-p", "hi"]);
    expect(parsed.web).toBeUndefined();
    expect(parsed.port).toBeUndefined();
    expect(parsed.dev).toBeUndefined();
  });
});
