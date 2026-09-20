import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession, getSessionMessages, sendMessage, stopMessage } from "../src/api.js";

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

describe("api", () => {
  it("getSession 请求 /api/session 并返回会话", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessionId: "s1" }));
    vi.stubGlobal("fetch", fetchMock);
    const session = await getSession();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(session).toEqual({ sessionId: "s1" });
  });

  it("getSessionMessages 对文件名做 URL 编码", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await getSessionMessages("a b/中文.jsonl");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/sessions/");
    expect(url).not.toContain(" ");
  });

  it("sendMessage 发送 POST JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage("hello");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello" });
  });

  it("stopMessage 发送 POST /api/stop", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await stopMessage();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/stop");
    expect(init.method).toBe("POST");
  });

  it("非 2xx 抛错并带服务端 error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, false, 500));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSession()).rejects.toThrow("boom");
  });
});
