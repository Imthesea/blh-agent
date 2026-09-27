import { afterEach, describe, expect, it, vi } from "vitest";
import { traceApi } from "../src/trace.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("traceApi", () => {
  it("overview 请求 /api/trace/overview 并返回结果", async () => {
    const body = {
      usage: { total: { in: 1, out: 2, costUsd: 0.01 }, byDay: {}, byProvider: {}, byModel: {} },
      today: { turns: 1, tools: 2, avgLatencyMs: 100 },
      recentTurns: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const overview = await traceApi.overview();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trace/overview",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(overview).toEqual(body);
  });

  it("turns 拼接 date/sid/limit 查询参数", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await traceApi.turns({ date: "2026-09-27", sid: "a.jsonl", limit: 10 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/trace/turns?");
    expect(url).toContain("date=2026-09-27");
    expect(url).toContain("sid=a.jsonl");
    expect(url).toContain("limit=10");
  });

  it("turns 无参数时不带查询串", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await traceApi.turns();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/trace/turns");
  });

  it("events 携带 cursor 与可选 date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ events: [], nextCursor: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await traceApi.events(5, "2026-09-27");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/trace/events?");
    expect(url).toContain("cursor=5");
    expect(url).toContain("date=2026-09-27");
  });

  it("files 返回日期列表", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(["2026-09-27"]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(traceApi.files()).resolves.toEqual(["2026-09-27"]);
  });

  it("非 2xx 抛错并带服务端 error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "trace unavailable" }, false, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(traceApi.overview()).rejects.toThrow("trace unavailable");
  });
});
