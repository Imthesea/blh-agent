import type { ToolRegistry } from "../tools/registry.js";
import type { ToolParameters } from "../core/types.js";
import {
  HttpTransport,
  StdioTransport,
  type Transport,
  type TransportMessage,
} from "./mcp-transport.js";

// MCP 协议版本号：告诉服务器「客户端按哪一版协议跟你对话」。
// 2026-07-28 是当前最新版：从这一版起 MCP 改成「无状态协议」，不再需要 initialize 握手，
// 而是每个请求都在 _meta 里带上版本号，由服务器逐个请求独立校验。
const PROTOCOL_VERSION = "2026-07-28";

// 客户端身份信息：随每个请求的 _meta 一起发给服务器，标明「我是谁」。
const CLIENT_INFO = { name: "blh", version: "0.1.0" };

// 旧版协议版本号：回退到 initialize 握手时，客户端声明自己按这一版旧协议通信。
// 2025-06-18 是当前生态里最主流的 legacy 版本（天气、酒店等服务器大多用它）。
const LEGACY_PROTOCOL_VERSION = "2025-06-18";

// 被识别的 modern 错误码：服务器是 modern 但不支持请求版本，不能回退 initialize。
const UNSUPPORTED_VERSION = -32022;

/**
 * MCPClient：一个「已连上的 MCP 服务器」的客户端封装。
 *
 * 大白话：它负责跟一个 MCP 服务器「用协议对话」。底层怎么收发消息，交给 Transport（传输层）去做；
 * 这一层只管协议本身：给请求编 id、等响应、超时、以及判断服务器是新协议还是旧协议。
 *
 * 两个职责分得很清楚：
 * - Transport（mcp-transport.ts）：管「怎么发、怎么收」——本地子进程还是远程 HTTP。
 * - MCPClient（本类）：管「发什么、收到后怎么对应」——编 id、登记等待表、拼 _meta、握手探测。
 */
export class MCPClient {
  // 自增的请求编号：每发一个请求就 +1，用它把「请求」和「响应」一一对上。
  private nextId = 1;
  // 待响应的请求表：key 是请求 id，value 是该请求的 resolve / reject / 超时定时器。
  // 服务器回复时，按 id 从这里取出对应请求，调用 resolve 或 reject 结束等待。
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  // 当前通信模式：modern = 新协议（每请求带 _meta），legacy = 旧协议（initialize 握手后无 _meta）。
  private mode: "modern" | "legacy" = "modern";

  constructor(
    readonly name: string, // 服务器名字，主要用于报错提示。
    readonly transport: Transport, // 底层传输通道（stdio 或 http）。
    readonly timeout = 30000, // 单个请求的超时时间（毫秒），默认 30 秒。
    readonly discoverTimeoutMs = 2000, // discover 探测的短超时（毫秒），快速识别不响应的旧服务器。
  ) {
    // 把「收到消息」「连接断开」两个事件接到自己的处理方法上。
    transport.onMessage((msg) => this.handleMessage(msg));
    transport.onDisconnect((error) => this.failPending(error));
  }

  // 启动底层连接，探测服务器是新版协议还是旧版协议，并完成对应的握手。
  async start(): Promise<void> {
    // 先建立底层连接（stdio 启动子进程，http 校验地址）。
    await this.transport.start();
    // 发一个 server/discover 请求，探测服务器是「新版」还是「旧版」协议。
    let discovered: unknown;
    try {
      discovered = await this.request("server/discover", {}, this.discoverTimeoutMs);
    } catch (error) {
      // 只有「超时」才代表旧服务器不响应 discover，回退到旧协议；
      // 进程退出 / 启动失败 / 网络错误等其它错误是真正的失败，直接抛出。
      if (!(error instanceof Error) || !error.message.includes("timed out")) {
        throw error;
      }
      this.mode = "legacy";
      await this.initializeLegacy();
      return;
    }
    // discover 返回了 error，分两种情况处理。
    if (discovered && typeof discovered === "object" && "error" in discovered) {
      const code = (discovered as { error?: { code?: number } }).error?.code;
      if (code === UNSUPPORTED_VERSION) {
        // 新版服务器，但不支持我们请求的版本 —— 不回退，直接报错。
        throw new Error(`MCP server does not support protocol version ${PROTOCOL_VERSION}`);
      }
      // 其它任何错误（常见 -32601 Method not found）= 旧版服务器，回退到 initialize 握手。
      this.mode = "legacy";
      await this.initializeLegacy();
      return;
    }
    // discover 正常返回 = 新版服务器，检查它是否支持我们用的协议版本。
    const supported =
      (discovered as { supportedVersions?: string[] } | undefined)?.supportedVersions ?? [];
    if (!supported.includes(PROTOCOL_VERSION)) {
      throw new Error(
        `MCP server does not support protocol version ${PROTOCOL_VERSION} (supported: ${supported.join(", ") || "unknown"})`,
      );
    }
  }

  // 向服务器要「它提供了哪些工具」，返回工具定义数组。
  async listTools(): Promise<Record<string, unknown>[]> {
    // 发 tools/list 请求，拿到服务器支持的工具列表。
    const result = await this.request("tools/list", {});
    // 如果返回的是 error，说明查询失败，直接抛错。
    if (result && typeof result === "object" && "error" in result) {
      throw new Error(`tools/list failed: ${JSON.stringify(result.error)}`);
    }
    // 正常情况下 result 形如 { tools: [...] }，把 tools 取出来；没有就返回空数组。
    return (result as { tools?: Record<string, unknown>[] } | undefined)?.tools ?? [];
  }

  // 调用服务器上的某个工具，把结果中的「文本内容」拼成字符串返回。
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // 发 tools/call 请求，让服务器执行指定工具。
    const result = await this.request("tools/call", { name: toolName, arguments: args });
    // 工具执行出错时，不抛异常，而是把错误信息作为字符串返回（这样能喂回给模型看）。
    if (result && typeof result === "object" && "error" in result) {
      return `MCP error: ${JSON.stringify(result.error)}`;
    }
    // MCP 的返回结果里 content 是一个数组，每一项可能是文本、图片等。这里只取 type 为 text 的项。
    const content = (result as { content?: unknown[] } | undefined)?.content ?? [];
    const text = content
      .filter(
        (c): c is { type: string; text?: string } =>
          typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
      )
      .map((c) => c.text ?? "") // 把每段文本拿出来。
      .join("\n"); // 多段文本用换行拼接。
    // 如果没有任何文本内容，返回一个占位提示，避免调用方拿到空串。
    return text || "(empty result)";
  }

  // 关闭底层连接（stdio 停掉子进程，http 无操作）。
  async close(): Promise<void> {
    await this.transport.close();
  }

  // 处理「收到一条服务器消息」：没有 id 的是通知，跳过；有 id 的按 id 找到等待中的请求并交回结果。
  private handleMessage(msg: TransportMessage): void {
    if (typeof msg.id !== "number") return; // 通知不需要回应，跳过。
    const entry = this.pending.get(msg.id);
    if (entry) {
      this.pending.delete(msg.id);
      clearTimeout(entry.timer); // 有响应了，取消超时定时器。
      // 有 error 就把 error 包成对象交回（上层统一判断 error 字段），否则交回 result。
      entry.resolve(msg.error !== undefined ? { error: msg.error } : msg.result);
    }
  }

  // 发送一个「请求」（带 id、需要响应），返回一个 Promise，等服务器回复后 resolve。
  // timeoutMs 可选：不传就用默认超时 this.timeout；discover 探测会传一个更短的超时。
  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    // 每个请求分配一个自增 id。
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.timeout;
    return new Promise<unknown>((resolve, reject) => {
      // 给这个请求设一个超时定时器：超时后从等待表移除并 reject。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      // 把请求的 resolve / reject / 定时器登记到等待表，等 handleMessage 里读到响应时调用。
      this.pending.set(id, { resolve, reject, timer });
      const base = (params as Record<string, unknown>) ?? {};
      // 只有新版协议才在 params 里带 _meta（版本号 + 客户端身份 + 能力）；
      // 旧版协议没有这个概念，带了反而会让旧服务器困惑。
      const requestParams = this.mode === "legacy" ? base : { ...base, _meta: this.requestMeta() };
      // 真正把消息发出去。发不出去（如 http 网络错误）时，把还在等待的当前请求判为失败。
      this.transport.send({ jsonrpc: "2.0", id, method, params: requestParams }, effectiveTimeout).catch(
        (error) => {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            clearTimeout(entry.timer);
            entry.reject(error);
          }
        },
      );
    });
  }

  // 生成每个请求都要带的 _meta：告诉服务器「我按哪个版本、以什么身份、有什么能力在跟你说话」。
  private requestMeta(): Record<string, unknown> {
    return {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }

  // 发一条「通知」：没有 id，服务器不会回复。旧版协议的握手会用到（notifications/initialized）。
  private sendNotification(method: string, params?: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params: params ?? {} }).catch(() => {
      // 通知没有响应，发不出去也没法补救，忽略即可。
    });
  }

  // 旧版协议的初始化握手：先发 initialize 建立会话，再补一条 initialized 通知。
  // 注意：调用前 this.mode 已经是 "legacy"，所以 request() 不会给 initialize 加 _meta。
  private async initializeLegacy(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (result && typeof result === "object" && "error" in result) {
      throw new Error(`initialize failed: ${JSON.stringify(result.error)}`);
    }
    this.sendNotification("notifications/initialized");
  }

  // 把当前所有还在等待的请求全部判为失败（通常用于连接断开时）。
  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer); // 取消每个请求的超时定时器。
      entry.reject(error); // 用同一个错误拒绝它们。
    }
    this.pending.clear(); // 清空等待表。
  }
}

// 正则：匹配所有「不是字母、数字、下划线、连字符」的字符，用来清洗名字里的非法字符。
const DISALLOWED = /[^a-zA-Z0-9_-]/g;

// 把 MCP 服务器名/工具名清洗成「安全名」：把非法字符替换成下划线，保证名字里只有安全字符。
export function normalizeMcpName(name: string): string {
  const normalized = name.replace(DISALLOWED, "_");
  // 如果清洗后变成空串（比如名字全是不合法字符），说明这个名字根本没法用，直接抛错。
  if (!normalized) throw new Error("MCP names cannot normalize to an empty string");
  return normalized;
}

/**
 * MCPRegistry：管理多个 MCP 服务器的「注册中心」。
 *
 * 大白话：它可以连接多个 MCP 服务器，把每个服务器提供的工具都改个带前缀的名字（比如 mcp__server__tool）
 * 注册进全局工具表里，同时记住「每个工具来自哪个服务器」，方便查重、回滚、写进系统提示词。
 */
export class MCPRegistry {
  // 已连接的服务器表：key 是服务器名，value 是对应的客户端。
  private readonly clients = new Map<string, MCPClient>();
  // 工具来源表：key 是带前缀的工具名，value 是「它来自哪个服务器/工具」的描述，用于查重。
  private readonly origins = new Map<string, string>();

  constructor(
    readonly registry: ToolRegistry, // 全局工具注册表，连接成功后把工具注册进去。
    readonly workdir: string, // 工作目录（当前代码里未直接使用，留作扩展）。
  ) {}

  // 连接一个「本地 stdio」类型的 MCP 服务器：启动它、发现工具、注册进全局工具表。
  async connect(name: string, command: string, args?: string[]): Promise<string> {
    if (!command.trim()) return "Error: server command is required";
    const client = new MCPClient(name, new StdioTransport(command, args ?? [], name));
    return this.connectClient(name, client);
  }

  // 连接一个「远程 HTTP」类型的 MCP 服务器（streamable-http）。
  async connectHttp(name: string, url: string, headers?: Record<string, string>): Promise<string> {
    const client = new MCPClient(name, new HttpTransport(url, headers ?? {}));
    return this.connectClient(name, client);
  }

  // 连接流程的公共部分（两种传输共用）：校验 → 启动 → 发现工具 → 注册 → 回滚。
  private async connectClient(name: string, client: MCPClient): Promise<string> {
    // 基本校验：服务器名不能为空，也不能重复连接同一个名字。
    if (!name) return "Error: server name is required";
    if (this.clients.has(name)) return `MCP server '${name}' already connected`;
    // 先把服务器名清洗成安全形式（用于拼工具名前缀）。
    const safeServer = normalizeMcpName(name);
    // 记录「本次连接已经成功注册了哪些工具名」，一旦后面出错，就按这个列表回滚。
    const registered: string[] = [];
    try {
      // 建立连接 + 完成协议握手。
      await client.start();
      // 拿到这个服务器提供的所有工具定义。
      const tools = await client.listTools();
      for (const toolDef of tools) {
        const rawName = String(toolDef.name ?? "");
        if (!rawName) continue; // 没名字的工具跳过。
        const safeTool = normalizeMcpName(rawName);
        // 拼出带前缀的全局唯一工具名：mcp__<服务器名>__<工具名>。
        const prefixed = `mcp__${safeServer}__${safeTool}`;
        // 工具名太长（超过 64 字符）会超出模型工具名上限，视为失败，回滚并断开。
        if (prefixed.length > 64) {
          this.rollback(registered);
          await client.close();
          return `Error: MCP tool name too long: ${prefixed}`;
        }
        // 名字跟已有工具冲突（撞名）时，同样回滚并断开。
        if (this.origins.has(prefixed)) {
          this.rollback(registered);
          await client.close();
          return `Error: MCP tool name collision: ${prefixed}`;
        }
        // 取工具的参数 schema；没有或不是 object 类型时，给一个空对象 schema 兜底。
        const schema = toolDef.inputSchema;
        const parameters: ToolParameters =
          schema && typeof schema === "object" && (schema as { type?: string }).type === "object"
            ? (schema as ToolParameters)
            : { type: "object", properties: {} };
        // 记录这个工具名来自哪个服务器/工具（供后续查重和提示词使用）。
        this.origins.set(prefixed, `MCP tool '${name}/${rawName}'`);
        // 真正把工具注册进全局工具表；调用时委托给 client.callTool 执行。
        this.registry.register({
          name: prefixed,
          description: String(toolDef.description ?? ""),
          parameters,
          handler: (callArgs) => client.callTool(rawName, callArgs),
        });
        registered.push(prefixed);
      }
      // 全部注册成功，把客户端存进连接表。
      this.clients.set(name, client);
      return `Connected to MCP server '${name}'. Discovered ${registered.length} tools: ${registered.join(", ") || "none"}`;
    } catch (error) {
      // 中间任何一步抛错，都要回滚已注册的工具并关闭连接，避免留下「半成品」。
      this.rollback(registered);
      await client.close();
      const message = error instanceof Error ? error.message : String(error);
      return `Error: failed to connect MCP server '${name}': ${message}`;
    }
  }

  // 回滚：把本次连接已经注册的工具从全局工具表里撤掉，并清掉对应的来源记录。
  private rollback(registered: string[]): void {
    for (const name of registered) {
      this.registry.unregister(name);
      this.origins.delete(name);
    }
  }

  // 关闭全部 MCP 连接，并移除它们注册到全局工具表里的工具。
  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    const tools = [...this.origins.keys()];
    this.clients.clear();
    this.origins.clear();
    for (const name of tools) this.registry.unregister(name);
    const results = await Promise.allSettled(clients.map((client) => client.close()));
    const errors = results
      .map((result) => (result.status === "rejected" ? result.reason : undefined))
      .filter((error): error is unknown => error !== undefined);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new Error(
        `failed to close ${errors.length} MCP clients: ${errors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join("; ")}`,
      );
    }
  }

  // 生成一段「已连接 MCP 服务器」的说明文字，用于拼进系统提示词，让模型知道有哪些服务器可用。
  systemPromptSection(): string {
    if (this.clients.size === 0) return ""; // 没连任何服务器就不输出。
    return "Connected MCP servers: " + [...this.clients.keys()].join(", ");
  }
}
