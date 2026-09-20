import { afterEach, describe, it, expect, vi } from "vitest";
import { retryDelay, retryAfterSeconds, isRetryable, withRetry } from "../../src/providers/retry.js";

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

function retryableError(
  status: number,
  headers?: { get(name: string): string | null },
): Error & { status: number; headers?: { get(name: string): string | null } } {
  return Object.assign(new Error(`http ${status}`), {
    status,
    ...(headers ? { headers } : {}),
  });
}

describe("retryAfterSeconds", () => {
  it("from header", () => {
    const error = retryableError(429, {
      get: (name) => (name === "Retry-After" ? "3" : null),
    });
    expect(retryAfterSeconds(error)).toBe(3);
  });

  it("invalid returns undefined", () => {
    const error = retryableError(429, {
      get: (name) => (name === "Retry-After" ? "abc" : null),
    });
    expect(retryAfterSeconds(error)).toBeUndefined();
  });

  it("no headers returns undefined", () => {
    expect(retryAfterSeconds(new Error("boom"))).toBeUndefined();
  });
});

describe("retryDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("doubles with attempt, capped at 32", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(retryDelay(0)).toBe(1);
    expect(retryDelay(1)).toBe(2);
    expect(retryDelay(5)).toBe(32);
    expect(retryDelay(10)).toBe(32);
  });

  it("bounded and jittered", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(retryDelay(10)).toBe(16);
  });

  it("prefers Retry-After", () => {
    const error = retryableError(429, {
      get: (name) => (name === "Retry-After" ? "7" : null),
    });
    expect(retryDelay(0, error)).toBe(7);
  });
});

describe("isRetryable", () => {
  it("retries 429 and 5xx", () => {
    expect(isRetryable(httpError(429))).toBe(true);
    expect(isRetryable(httpError(500))).toBe(true);
    expect(isRetryable(httpError(503))).toBe(true);
  });
  it("does not retry other 4xx", () => {
    expect(isRetryable(httpError(400))).toBe(false);
    expect(isRetryable(httpError(401))).toBe(false);
    expect(isRetryable(httpError(404))).toBe(false);
  });
  it("retries errors without status (network failures)", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
  });
  it("does not retry abort errors", () => {
    expect(isRetryable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isRetryable(Object.assign(new Error("aborted"), { name: "APIUserAbortError", status: undefined }))).toBe(false);
    expect(isRetryable(Object.assign(new Error("aborted"), { name: "CanceledError" }))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors until success", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue("ok");
    const p = withRetry(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws non-retryable errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(withRetry(fn)).rejects.toThrow("http 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry abort errors", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }));
    await expect(withRetry(fn)).rejects.toThrow("aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(httpError(503));
    const p = withRetry(fn, 3);
    const assertion = expect(p).rejects.toThrow("http 503");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
