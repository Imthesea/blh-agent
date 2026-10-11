import { describe, it, expect, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { serializeEvent, SSEBroadcaster, truncateForWire, MAX_WIRE_FIELD_CHARS } from "../src/bridge.js";
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

describe("truncateForWire", () => {
  it("截断超长的 tool_call 参数并追加标记", () => {
    const long = "x".repeat(MAX_WIRE_FIELD_CHARS + 100);
    const out = truncateForWire({ type: "tool_call", id: "c1", name: "write_file", arguments: long });
    expect(out.type).toBe("tool_call");
    expect((out as { arguments: string }).arguments.length).toBeLessThan(long.length);
    expect((out as { arguments: string }).arguments).toContain("[truncated,");
    expect((out as { arguments: string }).arguments).toContain("8100 chars total");
  });

  it("截断超长的 tool_result 输出", () => {
    const long = "y".repeat(MAX_WIRE_FIELD_CHARS * 2);
    const out = truncateForWire({ type: "tool_result", id: "c1", name: "bash", output: long, isError: false });
    expect((out as { output: string }).output.length).toBeLessThan(long.length);
    expect((out as { output: string }).output).toContain("[truncated,");
  });

  it("保留未超限的事件原样", () => {
    const event: WebEvent = { type: "tool_call", id: "c1", name: "bash", arguments: "{}" };
    expect(truncateForWire(event)).toEqual(event);
    expect(truncateForWire({ type: "turn_end" })).toEqual({ type: "turn_end" });
  });

  it("broadcast 走 truncateForWire：大帧被截断", () => {
    const broadcaster = new SSEBroadcaster();
    const write = vi.fn((_chunk: string) => true);
    const res = makeRes({ write });
    broadcaster.subscribe(res);
    write.mockClear();

    broadcaster.broadcast({
      type: "tool_call",
      id: "c1",
      name: "write_file",
      arguments: "z".repeat(MAX_WIRE_FIELD_CHARS + 500),
    });

    const frame = writtenFrames(write)[0] ?? "";
    expect(frame).toContain("[truncated,");
    expect(frame.length).toBeLessThan(MAX_WIRE_FIELD_CHARS + 1000);
  });
});

/** 构造一个带默认行为的假 ServerResponse，测试可覆盖特定字段。 */
function makeRes(overrides: Record<string, unknown> = {}) {
  return {
    writeHead: vi.fn(),
    write: vi.fn((_chunk: string) => true),
    end: vi.fn(),
    once: vi.fn(),
    destroyed: false,
    writableEnded: false,
    ...overrides,
  } as unknown as ServerResponse;
}

/** 取出 write mock 写出的帧内容。 */
function writtenFrames(write: ReturnType<typeof vi.fn>): string[] {
  return (write.mock.calls as unknown as string[][]).map((c) => c[0] ?? "");
}

describe("SSEBroadcaster", () => {
  it("订阅后广播、取消订阅后不再广播", () => {
    const broadcaster = new SSEBroadcaster();
    const write = vi.fn((_chunk: string) => true);
    const res = makeRes({ write });

    const off = broadcaster.subscribe(res);
    expect(broadcaster.clientCount).toBe(1);
    write.mockClear(); // 忽略连接握手注释帧
    broadcaster.broadcast({ type: "turn_end" });
    expect(write).toHaveBeenCalledTimes(1);

    off();
    expect(broadcaster.clientCount).toBe(0);
    broadcaster.broadcast({ type: "turn_end" });
    expect(write).toHaveBeenCalledTimes(1); // 取消订阅后不再新增

    expect(writtenFrames(write).filter((f) => f.includes("event: turn_end"))).toHaveLength(1);
  });

  it("跳过已销毁的连接，不中断其它客户端广播", () => {
    const broadcaster = new SSEBroadcaster();
    const healthyWrite = vi.fn((_chunk: string) => true);
    const healthy = makeRes({ write: healthyWrite });
    const deadWrite = vi.fn((_chunk: string) => true);
    const dead = makeRes({ write: deadWrite, destroyed: true });

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

  it("write 返回 false（背压）时挂起等待 drain，不断开连接", () => {
    const broadcaster = new SSEBroadcaster();
    let drainCb: (() => void) | undefined;
    const write = vi.fn((_chunk: string) => false);
    const res = makeRes({
      write,
      once: vi.fn((event: string, cb: () => void) => {
        if (event === "drain") drainCb = cb;
      }),
    });

    broadcaster.subscribe(res);
    write.mockClear();
    broadcaster.broadcast({ type: "turn_end" });

    // 内核缓冲满：不该断开，只应挂起等 drain。
    expect(write).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(1);
    expect(drainCb).toBeDefined();

    // 内核缓冲排空后继续工作；再广播一条能正常写出。
    drainCb!();
    write.mockReturnValue(true);
    write.mockClear();
    broadcaster.broadcast({ type: "turn_start" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(broadcaster.clientCount).toBe(1);
  });

  it("队列堆积超过上限时断开真·慢客户端", () => {
    const broadcaster = new SSEBroadcaster({ maxQueuedBytes: 10 });
    const write = vi.fn((_chunk: string) => false); // 永远写不进去 → 帧全部堆积
    const res = makeRes({ write });

    broadcaster.subscribe(res);
    broadcaster.broadcast({
      type: "tool_result",
      id: "call_1",
      name: "bash",
      output: "x".repeat(1000),
      isError: false,
    });

    expect(res.end).toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(0);
  });

  it("单帧超过缓冲区也不断开健康客户端", () => {
    const broadcaster = new SSEBroadcaster({ maxQueuedBytes: 8 * 1024 * 1024 });
    // 模拟一个帧 >16KB（write 返回 false），但队列远未达到上限。
    const write = vi.fn((_chunk: string) => false);
    let drainCb: (() => void) | undefined;
    const res = makeRes({
      write,
      once: vi.fn((event: string, cb: () => void) => {
        if (event === "drain") drainCb = cb;
      }),
    });

    broadcaster.subscribe(res);
    broadcaster.broadcast({
      type: "tool_result",
      id: "call_1",
      name: "bash",
      output: "x".repeat(30_000),
      isError: false,
    });

    expect(res.end).not.toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(1);
    expect(drainCb).toBeDefined();
  });

  it("close 后断开全部客户端并拒绝新订阅", () => {
    const broadcaster = new SSEBroadcaster();
    const write = vi.fn((_chunk: string) => true);
    const res = makeRes({ write });
    broadcaster.subscribe(res);

    broadcaster.close();

    expect(res.end).toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(0);
    write.mockClear();
    broadcaster.broadcast({ type: "turn_end" });
    expect(write).not.toHaveBeenCalled();

    const late = makeRes();
    const off = broadcaster.subscribe(late);
    expect(late.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(late.end).toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(0);
    off();
  });
});
