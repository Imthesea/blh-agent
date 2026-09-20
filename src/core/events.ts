import { createLogger } from "@blh/logger";

const log = createLogger("core.events");

/** agentLoop 对外产出的高层事件：文本增量、工具进度与轮次边界。 */
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_cancelled"; text: string }
  | { type: "turn_end" };

type Listener = (event: AgentEvent) => void;

/** 纯发布订阅事件总线：无返回值、无阻塞语义，供 REPL 订阅 agent 高层事件。 */
export class EventBus {
  private readonly listeners: Listener[] = [];

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (error) {
        log.warn("event listener error", {
          type: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
