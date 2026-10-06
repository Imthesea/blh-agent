import { describe, it, expect, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { serializeEvent, SSEBroadcaster } from "../src/bridge.js";
import type { WebEvent } from "../src/types.js";

describe("serializeEvent", () => {
  it("序列化文本增量", () => {
    const event: WebEvent = { type: "assistant_text_delta", text: "你好" };
    expect(serializeEvent(event)).toBe('event: assistant_text_delta\ndata: {"text":"你好"}\n\n');
  });

  it("序列化无载荷事件", () => {
    expect(serializeEvent({ type: "turn_start" })).toBe("event: turn_start\ndata: {}\n\n");
  });

  it("序列化审批事件", () => {
    const event: WebEvent = {
      type: "approval_requested",
      requestId: "r1",
      tool: "bash",
      target: "ls",
      args: { command: "ls" },
    };
    expect(serializeEvent(event)).toBe(
      'event: approval_requested\ndata: {"requestId":"r1","tool":"bash","target":"ls","args":{"command":"ls"}}\n\n',
    );
  });
});

describe("SSEBroadcaster", () => {
  it("订阅后广播、取消订阅后不再广播", () => {
    const broadcaster = new SSEBroadcaster();
    const write = vi.fn();
    const res = { writeHead: vi.fn(), write, end: vi.fn() } as unknown as ServerResponse;

    const off = broadcaster.subscribe(res);
    expect(broadcaster.clientCount).toBe(1);
    broadcaster.broadcast({ type: "turn_end" });

    off();
    expect(broadcaster.clientCount).toBe(0);
    broadcaster.broadcast({ type: "turn_end" });

    const frames = write.mock.calls.map((c) => c[0] as string);
    expect(frames.filter((f) => f.includes("event: turn_end"))).toHaveLength(1);
  });

  it("跳过已销毁的连接，不中断其它客户端广播", () => {
    const broadcaster = new SSEBroadcaster();
    const healthyWrite = vi.fn(() => true);
    const healthy = { writeHead: vi.fn(), write: healthyWrite, end: vi.fn() } as unknown as ServerResponse;
    const deadWrite = vi.fn(() => true);
    const dead = { writeHead: vi.fn(), write: deadWrite, end: vi.fn(), destroyed: true } as unknown as ServerResponse;

    broadcaster.subscribe(healthy);
    broadcaster.subscribe(dead);
    expect(broadcaster.clientCount).toBe(2);

    healthyWrite.mockClear();
    deadWrite.mockClear();
    broadcaster.broadcast({ type: "turn_end" });

    expect(healthyWrite).toHaveBeenCalled();
    expect(deadWrite).not.toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(1);
  });

  it("write 返回 false（背压）时断开慢客户端", () => {
    const broadcaster = new SSEBroadcaster();
    const slowWrite = vi.fn(() => false);
    const slow = { writeHead: vi.fn(), write: slowWrite, end: vi.fn() } as unknown as ServerResponse;

    broadcaster.subscribe(slow);
    expect(broadcaster.clientCount).toBe(1);

    broadcaster.broadcast({ type: "turn_end" });

    expect(slowWrite).toHaveBeenCalled();
    expect(slow.end).toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(0);
  });

  it("close 后断开全部客户端并拒绝新订阅", () => {
    const broadcaster = new SSEBroadcaster();
    const write = vi.fn(() => true);
    const res = { writeHead: vi.fn(), write, end: vi.fn() } as unknown as ServerResponse;
    broadcaster.subscribe(res);

    broadcaster.close();

    expect(res.end).toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(0);
    write.mockClear();
    broadcaster.broadcast({ type: "turn_end" });
    expect(write).not.toHaveBeenCalled();

    const late = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    const off = broadcaster.subscribe(late);
    expect(late.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(late.end).toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(0);
    off();
  });
});
