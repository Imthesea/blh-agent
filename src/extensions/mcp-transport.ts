import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// 一条「已解析好的」服务器响应消息：可能有 id（表示是对某个请求的回复），也可能没有（是通知）。
// result 和 error 二选一：正常返回带 result，出错带 error。
export interface TransportMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

/**
 * Transport：MCP 客户端和服务器之间的「底层通信通道」的抽象。
 *
 * 大白话：不管服务器是「本地子进程」还是「远程 HTTP 地址」，客户端都只通过这一套方法跟它收发消息。
 * 上层（MCPClient）不关心消息是怎么发出去的、怎么收上来的，只调用这些方法。
 *
 * 两个实现：
 * - StdioTransport：启动本地子进程，通过标准输入输出通信。
 * - HttpTransport：往一个 URL 发 HTTP POST，通过 HTTP 响应通信。
 */
export interface Transport {
  /** 建立底层连接：stdio 就启动子进程，http 就校验地址（http 没有「连接」这一说）。 */
  start(): Promise<void>;
  /**
   * 发一条 JSON-RPC 消息。
   * 返回的 Promise 在「消息被成功发出」时 resolve；发不出去（比如网络错误）时 reject。
   * 注意：这里的 resolve 不代表「服务器已回复」，服务器回复是通过 onMessage 回调交上来的。
   * timeoutMs 可选：http 用它给本次请求设网络超时；stdio 忽略它（超时由上层统一管理）。
   */
  send(msg: unknown, timeoutMs?: number): Promise<void>;
  /** 关闭底层连接。 */
  close(): Promise<void>;
  /** 注册「收到服务器消息」的回调。 */
  onMessage(handler: (msg: TransportMessage) => void): void;
  /** 注册「连接断开或出错」的回调（stdio 的进程退出、http 无法连接等）。 */
  onDisconnect(handler: (error: Error) => void): void;
}

// Windows 上判断是否要用 shell 来启动命令。
// 只有 .exe / .com 是可执行文件、能直接 spawn；
// 无扩展名的裸命令（如 npx）实际是 .cmd 批处理文件，需要交给 shell 才能命中。
function needsShell(command: string): boolean {
  if (process.platform !== "win32") return false;
  return !/\.(exe|com)$/i.test(command);
}

/**
 * StdioTransport：通过「本地子进程 + 标准输入输出」跟服务器通信。
 *
 * 大白话：这是 MCP 最传统的接法——服务器是个能直接跑起来的程序，我们启动它，
 * 往它的标准输入里一行一行写 JSON 请求，从它的标准输出里一行一行读 JSON 回复。
 * MCP 规定「一行一个 JSON」，所以用 readline 按行读最合适。
 */
export class StdioTransport implements Transport {
  // 子进程句柄：指向已启动的 MCP 服务器进程，没启动时是 null。
  private process: ChildProcessWithoutNullStreams | null = null;
  // 「收到消息」回调，由上层（MCPClient）在构造时注册。
  private messageHandler: ((msg: TransportMessage) => void) | null = null;
  // 「连接断开」回调，进程报错或退出时触发。
  private disconnectHandler: ((error: Error) => void) | null = null;

  constructor(
    readonly command: string, // 启动服务器的命令（可执行文件路径）。
    readonly args: string[] = [], // 启动命令的附加参数。
    readonly name?: string, // 服务器名字（用于报错提示），不传就用 command。
  ) {}

  onMessage(handler: (msg: TransportMessage) => void): void {
    this.messageHandler = handler;
  }

  onDisconnect(handler: (error: Error) => void): void {
    this.disconnectHandler = handler;
  }

  async start(): Promise<void> {
    const label = this.name ?? this.command;
    // 用 spawn 启动子进程，三个标准流都走管道，方便我们读写。
    // Windows 上要开 shell，否则像 npx 这种实际是 .cmd 批处理的命令会因找不到文件而启动失败。
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsShell(this.command),
    });
    // 子进程启动失败（比如命令路径写错、进程被杀）时，通知上层「连接断了」。
    this.process.on("error", (err) =>
      this.disconnectHandler?.(err instanceof Error ? err : new Error(String(err))),
    );
    // 子进程退出时，同样通知上层，避免还在等待的请求一直卡着。
    this.process.on("exit", (code) =>
      this.disconnectHandler?.(new Error(`MCP server '${label}' exited with code ${code}`)),
    );
    // 逐行读取子进程的 stdout，每行解析成一个 JSON 对象，交给上层的 onMessage 回调。
    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      let msg: TransportMessage;
      try {
        msg = JSON.parse(line) as TransportMessage;
      } catch {
        return; // 不是合法 JSON 的行直接忽略（可能是一些日志噪声）。
      }
      this.messageHandler?.(msg);
    });
  }

  async send(msg: unknown, _timeoutMs?: number): Promise<void> {
    const p = this.process;
    if (p === null) throw new Error(`MCP server '${this.name ?? this.command}' is not started`);
    // 把消息序列化成 JSON 字符串，写到子进程 stdin，末尾加换行。
    p.stdin.write(JSON.stringify(msg) + "\n");
  }

  async close(): Promise<void> {
    const p = this.process;
    if (p === null) return; // 没启动过，直接返回。
    // 先关掉 stdin 写入端，等于告诉子进程「我这边不会再发请求了」。
    p.stdin.end();
    // 等待子进程真正退出，最多等 5 秒；超时就强制 kill 掉。
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      // 兜底定时器：5 秒内还没退出就强制结束进程。
      const timer = setTimeout(() => {
        p.kill();
        done();
      }, 5000);
      // 正常退出时，取消定时器并结束等待。
      p.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    // 进程已经关闭，清空句柄。
    this.process = null;
  }
}

// 从一段 SSE（Server-Sent Events）文本里，找出「带 id 的那条 JSON-RPC 响应」并返回。
// SSE 里一条事件是一行 "data: {...}"，我们只关心最终那条带 id 的响应（result/error）。
function parseSSE(text: string): TransportMessage | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload) as TransportMessage;
      if (typeof obj.id === "number") return obj;
    } catch {
      // 不是合法 JSON 的 data 行直接跳过。
    }
  }
  return null;
}

/**
 * HttpTransport：通过「HTTP POST」跟远程服务器通信（streamable-http 传输）。
 *
 * 大白话：有些 MCP 服务器是跑在网上的（不是本地程序），给你一个 URL。你每个 JSON-RPC 请求
 * 都单独发一次 HTTP POST 到那个 URL，服务器在 HTTP 响应里把结果回给你。这就是 streamable-http。
 */
export class HttpTransport implements Transport {
  // 「收到消息」回调，由上层（MCPClient）在构造时注册。
  private messageHandler: ((msg: TransportMessage) => void) | null = null;
  // 「连接断开」回调（http 没有常驻连接，基本用不到，保留接口一致）。
  private disconnectHandler: ((error: Error) => void) | null = null;
  // 会话 id：旧协议的 http 服务器在 initialize 响应里返回 Mcp-Session-Id，要求后续请求都带上。
  private sessionId: string | null = null;

  constructor(
    readonly url: string, // 服务器暴露的 MCP 端点，比如 https://example.com/mcp。
    readonly headers: Record<string, string> = {}, // 自定义请求头，最常用的是认证头（Authorization）。
    readonly timeout = 30000, // 单个请求的网络超时（毫秒）。
  ) {}

  onMessage(handler: (msg: TransportMessage) => void): void {
    this.messageHandler = handler;
  }

  onDisconnect(handler: (error: Error) => void): void {
    this.disconnectHandler = handler;
  }

  async start(): Promise<void> {
    // http 没有「建立连接」这一说，这里只做最基本的地址校验。
    if (!/^https?:\/\//i.test(this.url)) {
      throw new Error(`MCP server URL must start with http:// or https://: ${this.url}`);
    }
  }

  async send(msg: unknown, timeoutMs?: number): Promise<void> {
    const m = msg as { id?: number; method?: string; params?: Record<string, unknown> };
    // 发一次 HTTP POST，带上规范要求的各种头。
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: this.buildHeaders(m),
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeout),
      });
    } catch (err) {
      // 网络错误 / 超时：把错误抛给上层，由上层 reject 对应的请求。
      throw err instanceof Error ? err : new Error(String(err));
    }
    // 服务器可能在 initialize 响应里返回会话 id，记下来供后续请求使用。
    const sid = res.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;
    // 非 2xx 状态（比如 401 认证失败、400 参数错）直接抛错，附上响应体便于排查。
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    // 通知（无 id）或 202 状态：服务器不会返回响应体，直接结束。
    if (res.status === 202 || typeof m.id !== "number") return;
    // 根据 Content-Type 判断响应是单个 JSON 还是 SSE 流。
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const parsed = parseSSE(await res.text());
      if (parsed) this.messageHandler?.(parsed);
      return;
    }
    // 默认当作单个 JSON 响应处理。
    const data = (await res.json()) as TransportMessage;
    this.messageHandler?.(data);
  }

  async close(): Promise<void> {
    // http 没有常驻连接，无需清理。
  }

  // 组装本次 POST 要带的请求头：规范要求的固定头 + 用户自定义头 + 会话 id。
  private buildHeaders(m: { method?: string; params?: Record<string, unknown> }): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // 告诉服务器：JSON 和 SSE 两种响应我们都收。
      Accept: "application/json, text/event-stream",
      ...this.headers, // 用户自定义头（如 Authorization），放在最后可覆盖固定头。
    };
    if (m.method) headers["Mcp-Method"] = m.method;
    // 协议版本头：优先取 body 里 _meta 的协议版本（新版协议），否则取 params.protocolVersion（旧版 initialize）。
    const params = m.params ?? {};
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const protocolVersion = meta["io.modelcontextprotocol/protocolVersion"] ?? params.protocolVersion;
    if (typeof protocolVersion === "string") headers["MCP-Protocol-Version"] = protocolVersion;
    // tools/call 请求要带 Mcp-Name，值就是被调用的工具名。
    if (m.method === "tools/call" && typeof params.name === "string") {
      headers["Mcp-Name"] = params.name;
    }
    // 旧协议有会话 id 时，后续请求都带上。
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }
}
