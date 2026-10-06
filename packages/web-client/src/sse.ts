import { createLogger } from "@blh/logger";
import { WEB_EVENT_TYPES, type WebEvent } from "@blh/web-protocol";

const log = createLogger("web-client.sse");

/** SSE 连接状态：open 表示已建立（或重连成功），error 表示连接失败/中断。 */
export type ConnectionStatus = "open" | "error";

/** 订阅 SSE 事件流，返回取消订阅函数（会关闭 EventSource）。 */
export function connectEvents(
  url: string,
  onEvent: (event: WebEvent) => void,
  onStatus?: (status: ConnectionStatus) => void,
): () => void {
  const es = new EventSource(url);
  es.onopen = () => onStatus?.("open");
  for (const type of WEB_EVENT_TYPES) {
    es.addEventListener(type, (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
        onEvent({ type, ...data } as WebEvent);
      } catch {
        log.warn("bad SSE payload", { type });
        onEvent({ type: "agent_error", message: `bad SSE payload for ${type}` });
      }
    });
  }
  es.onerror = () => {
    log.warn("SSE connection error", { readyState: es.readyState });
    onStatus?.("error");
  };
  return () => es.close();
}
