import type { ServerResponse } from "node:http";
import type { WebEvent } from "./types.js";

/** 把一条事件序列化成 SSE 帧（event: <type> + data: <json>）。纯函数，便于单测。 */
export function serializeEvent(event: WebEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 单个事件字段在 SSE 帧里的最大字符数。只给前端发预览，
 * 避免 write_file 等工具把整份文件内容塞进一帧撑爆连接与前端。
 */
export const MAX_WIRE_FIELD_CHARS = 8000;

function truncateWireText(text: string): string {
  if (text.length <= MAX_WIRE_FIELD_CHARS) return text;
  return `${text.slice(0, MAX_WIRE_FIELD_CHARS)}\n... [truncated, ${text.length} chars total]`;
}

/** 把要下发的直播事件做截断：工具参数 / 输出只保留预览。 */
export function truncateForWire(event: WebEvent): WebEvent {
  switch (event.type) {
    case "tool_call":
      return { ...event, arguments: truncateWireText(event.arguments) };
    case "tool_result":
      return { ...event, output: truncateWireText(event.output) };
    default:
      return event;
  }
}

/** 单个 SSE 客户端及其待发送队列。 */
interface SseClient {
  res: ServerResponse;
  queue: string[];
  queuedBytes: number;
  draining: boolean;
}

/** 单客户端待发字节上限：只有堆积超过这个值，才认定是真·慢客户端并断开。 */
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** 维护当前所有 SSE 连接并广播事件。 */
export class SSEBroadcaster {
  private readonly clients = new Set<SseClient>();
  private readonly maxQueuedBytes: number;
  private closed = false;

  constructor(options: { maxQueuedBytes?: number } = {}) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  }

  /** 接入一个新 SSE 客户端，返回取消订阅函数（会 end 连接）。 */
  subscribe(res: ServerResponse): () => void {
    if (this.closed) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server is shutting down" }));
      return () => {};
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const client: SseClient = { res, queue: [], queuedBytes: 0, draining: false };
    this.clients.add(client);
    // 客户端主动断开时立即清理，不必等下一次广播。
    res.once("close", () => {
      this.clients.delete(client);
    });
    return () => {
      this.clients.delete(client);
      if (!res.destroyed && !res.writableEnded) {
        try {
          res.end();
        } catch {
          // 关闭是 best-effort，单个连接失败不能阻塞其余连接释放。
        }
      }
    };
  }

  broadcast(event: WebEvent): void {
    if (this.closed) return;
    const frame = serializeEvent(truncateForWire(event));
    for (const client of [...this.clients]) {
      if (client.res.destroyed || client.res.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      client.queue.push(frame);
      client.queuedBytes += frame.length;
      if (client.queuedBytes > this.maxQueuedBytes) {
        this.drop(client);
        continue;
      }
      this.pump(client);
    }
  }

  /** 尽可能把队列里的帧写完；写不进去就挂起等 drain，而不是断开连接。 */
  private pump(client: SseClient): void {
    if (client.draining) return;
    for (;;) {
      if (client.res.destroyed || client.res.writableEnded) return;
      const frame = client.queue.shift();
      if (frame === undefined) return;
      client.queuedBytes -= frame.length;
      let ok: boolean;
      try {
        ok = client.res.write(frame);
      } catch {
        this.drop(client);
        return;
      }
      if (!ok) {
        // 内核写缓冲已满：挂起该客户端，等 drain 后再继续，而不是误判为死连接。
        client.draining = true;
        client.res.once("drain", () => {
          client.draining = false;
          this.pump(client);
        });
        return;
      }
    }
  }

  /** 断开并移除一个客户端（真正的死连接，或队列堆积超过上限）。 */
  private drop(client: SseClient): void {
    this.clients.delete(client);
    if (!client.res.destroyed && !client.res.writableEnded) {
      try {
        client.res.end();
      } catch {
        // best-effort
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    this.closed = true;
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        // 关闭是 best-effort，单个连接失败不能阻塞其余连接释放。
      }
    }
    this.clients.clear();
  }
}
