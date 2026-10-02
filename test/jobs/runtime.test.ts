import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/core/types.js";
import { BackgroundManager } from "../../src/jobs/background.js";
import { CronScheduler } from "../../src/jobs/cron.js";
import { AgentLock } from "../../src/core/agent-lock.js";
import { JobsRuntime } from "../../src/jobs/runtime.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "runtime-test-"));
});

afterEach(async () => {
  // Windows：后台进程可能仍以 tmpDir 为 cwd，立即 rmSync 会 EPERM；轮询重试直到进程退出
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});

const makeRuntime = () =>
  new JobsRuntime(
    new BackgroundManager(tmpDir),
    new CronScheduler(path.join(tmpDir, ".scheduled_tasks.json")),
  );

describe("JobsRuntime", () => {
  it("consumeAndInjectCron appends scheduled messages", () => {
    const runtime = makeRuntime();
    const job = runtime.cron.schedule("* * * * *", "run tests");
    runtime.cron.pollDue(new Date(2026, 8, 14, 10, 30));
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const fired = runtime.consumeAndInjectCron(messages);
    expect(fired.map((j) => j.id)).toEqual([job.id]);
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "[Scheduled] run tests",
    });
  });

  it("startBackground returns placeholder", () => {
    const runtime = makeRuntime();
    const result = runtime.startBackground("echo hi");
    expect(result.startsWith("[Background task bg_")).toBe(true);
    expect(result).toContain("later turn");
  });

  it("injectBackgroundResults appends notification", async () => {
    const runtime = makeRuntime();
    const taskId = runtime.background.start("echo hello");
    const deadline = Date.now() + 5000;
    while (runtime.background.tasks[taskId]?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const messages: ChatMessage[] = [];
    expect(runtime.injectBackgroundResults(messages)).toBe(1);
    expect(messages[messages.length - 1]?.content).toContain("<task_notification>");
  });

  it("injectBackgroundResults empty", () => {
    const runtime = makeRuntime();
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(runtime.injectBackgroundResults(messages)).toBe(0);
    expect(messages).toHaveLength(1);
  });

  it("start/stop idempotent", () => {
    const runtime = makeRuntime();
    runtime.start();
    runtime.start(); // 幂等
    expect(runtime.started).toBe(true);
    runtime.stop();
    runtime.stop(); // 幂等
    expect(runtime.started).toBe(false);
  });

  it("start schedules pollDue and stop clears the scheduler", () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime();
      const pollSpy = vi.spyOn(runtime.cron, "pollDue");
      runtime.start();
      vi.advanceTimersByTime(1000);
      expect(pollSpy).toHaveBeenCalled();
      runtime.stop();
      const callsAfterStop = pollSpy.mock.calls.length;
      vi.advanceTimersByTime(3000);
      expect(pollSpy.mock.calls.length).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries scheduled turn failure with backoff instead of stopping", async () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime();
      runtime.cron.schedule("* * * * *", "boom");
      runtime.cron.pollDue(new Date(2026, 8, 14, 10, 30));
      let attempts = 0;
      runtime.setCronTurn(async () => {
        attempts += 1;
        throw new Error("fail");
      });
      runtime.start();
      await vi.advanceTimersByTimeAsync(200);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(400);
      expect(attempts).toBe(2);
      expect(runtime.started).toBe(true);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abortBackground 中断进行中的 cronTurn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime();
      let aborted = false;
      runtime.cron.schedule("* * * * *", "tick");
      runtime.cron.pollDue(new Date(2026, 8, 14, 10, 30));
      runtime.setCronTurn((signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve(); });
      }));
      runtime.start();
      await vi.advanceTimersByTimeAsync(1_000);
      runtime.abortBackground();
      await vi.advanceTimersByTimeAsync(0);
      expect(aborted).toBe(true);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentLock", () => {
  it("tryAcquire succeeds when free and fails when held", () => {
    const lock = new AgentLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
  });

  it("acquire resolves immediately when free and then holds", async () => {
    const lock = new AgentLock();
    await expect(lock.acquire()).resolves.toBeUndefined();
    expect(lock.tryAcquire()).toBe(false);
  });

  it("acquire queues waiters FIFO and release hands off", async () => {
    const lock = new AgentLock();
    const order: number[] = [];
    lock.tryAcquire(); // 持锁
    const first = lock.acquire().then(() => order.push(1));
    const second = lock.acquire().then(() => order.push(2));
    lock.release(); // 移交给 first
    await first;
    expect(order).toEqual([1]);
    lock.release(); // 移交给 second
    await second;
    expect(order).toEqual([1, 2]);
  });

  it("withLock releases on throw", async () => {
    const lock = new AgentLock();
    await expect(
      lock.withLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.tryAcquire()).toBe(true);
  });
});

describe("JobsRuntime dream channel", () => {
  it("dream 到期时执行 dreamTurn（isDue 评估 60s 降频）", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime();
    let due = true;
    let ran = 0;
    runtime.setDreamTurn(async () => { const r = due; due = false; return r; }, async () => { ran += 1; });
    runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ran).toBe(1);
    runtime.stop();
    vi.useRealTimers();
  });

  it("dream 未到期不执行；60s 内 isDue 只评估一次", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime();
    let dueCalls = 0;
    runtime.setDreamTurn(async () => { dueCalls += 1; return false; }, async () => { throw new Error("must not run"); });
    runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dueCalls).toBe(1);
    runtime.stop();
    vi.useRealTimers();
  });

  it("abortBackground 中断进行中的 dreamTurn", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime();
    let aborted = false;
    runtime.setDreamTurn(async () => true, (signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); });
    }));
    runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    runtime.abortBackground();
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(true);
    runtime.stop();
    vi.useRealTimers();
  });

  it("dream 优先于 cron：同一窗口先跑 dream", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime();
    const order: string[] = [];
    runtime.cron.schedule("* * * * *", "tick");
    runtime.cron.pollDue(new Date(2026, 8, 14, 10, 30));
    runtime.setCronTurn(async () => { order.push("cron"); });
    let due = true;
    runtime.setDreamTurn(async () => { const r = due; due = false; return r; }, async () => { order.push("dream"); });
    runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order[0]).toBe("dream");
    expect(order).toContain("cron");
    runtime.stop();
    vi.useRealTimers();
  });
});
