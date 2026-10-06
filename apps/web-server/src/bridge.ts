import type { ServerResponse } from "node:http";
import type { WebEvent } from "./types.js";


/** 把一条事件序列化成 SSE 帧（event: <type> + data: <json>）。纯函数，便于单测。 */
export function serializeEvent(event: WebEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 维护当前所有 SSE 连接并广播事件。 */
export class SSEBroadcaster {
  private readonly clients = new Set<ServerResponse>();
  private closed = false;

  /** 接入一个新 SSE 客户端，返回取消订阅函数（会 end 连接）。 */
  subscribe(res: ServerResponse): () => void {
    if (this.closed) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server is shutting down" }));
      return () => this.clients.delete(res);
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    return () => {
      this.clients.delete(res);
      res.end();
    };
  }

  broadcast(event: WebEvent): void {
    if (this.closed) return;
    const frame = serializeEvent(event);
    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      try {
        if (!client.write(frame)) {
          // 背压：内核缓冲已满，直接丢弃慢客户端，避免内存无界增长
          this.clients.delete(client);
          client.end();
        }
      } catch {
        this.clients.delete(client);
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
        client.end();
      } catch {
        // 关闭是 best-effort，单个连接失败不能阻塞其余连接释放。
      }
    }
    this.clients.clear();
  }
}
