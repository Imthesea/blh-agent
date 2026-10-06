import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/runtime/events.js";
import type { AgentEvent } from "../../src/contracts/events.js";

describe("EventBus", () => {
  it("按注册顺序投递事件", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(async (e) => {
      seen.push(`a:${e.type}`);
    });
    bus.subscribe((e) => {
      seen.push(`b:${e.type}`);
    });
    await bus.emit({ type: "turn_start" });
    await bus.emit({ type: "assistant_text_delta", text: "hi" });
    expect(seen).toEqual([
      "a:turn_start",
      "b:turn_start",
      "a:assistant_text_delta",
      "b:assistant_text_delta",
    ]);
  });

  it("取消订阅后不再投递", async () => {
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    await bus.emit({ type: "turn_start" });
    off();
    await bus.emit({ type: "turn_end" });
    expect(seen.map((e) => e.type)).toEqual(["turn_start"]);
  });

  it("监听器抛错被隔离，不影响其他监听器", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => seen.push(e.type));
    await expect(bus.emit({ type: "turn_end" })).resolves.toBeUndefined();
    expect(seen).toEqual(["turn_end"]);
  });

  it("串行等待异步监听器", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe(async (e) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(e.type);
    });
    bus.subscribe((e) => order.push(`2:${e.type}`));
    await bus.emit({ type: "turn_start" });
    expect(order).toEqual(["turn_start", "2:turn_start"]);
  });
});
