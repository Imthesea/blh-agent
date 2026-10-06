import { createLogger } from "@blh/logger";
import type { AgentEvent } from "../contracts/events.js";

const log = createLogger("runtime.events");

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
