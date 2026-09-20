import { createLogger } from "@blh/logger";

const log = createLogger("providers.retry");

export function retryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") return undefined;
  const raw = get.call(headers, "Retry-After") as string | null;
  if (raw === null || raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function retryDelay(attempt: number, error?: unknown): number {
  const retryAfter = retryAfterSeconds(error);
  if (retryAfter !== undefined && retryAfter > 0) return retryAfter;
  const base = Math.min(2 ** attempt, 32);
  return base * (0.5 + Math.random());
}

export function isRetryable(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    // 用户主动中断（AbortController）不应重试；否则取消会被当作网络错误重试最多 5 次。
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError" || name === "APIUserAbortError" || name === "CanceledError") {
      return false;
    }
    if ("status" in error) {
      if (typeof error.status !== "number") return true; // status 不可读：按网络错误处理，可重试
      return error.status === 429 || error.status >= 500;
    }
  }
  return true; // 无 status：网络错误等，可重试
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      attempts += 1;
      if (attempts >= maxAttempts || !isRetryable(error)) throw error;
      const delay = retryDelay(attempts, error);
      log.warn("retrying", { attempt: attempts, delay });
      await sleep(delay);
    }
  }
}
