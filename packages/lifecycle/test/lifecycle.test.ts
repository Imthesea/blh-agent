import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  LifecycleDisposeError,
  LifecycleManager,
  type DisposableResource,
} from "../src/index.js";

function resource(
  id: string,
  overrides: Partial<DisposableResource> = {},
): DisposableResource & {
  cancelled: boolean;
  forced: boolean;
} {
  let cancelled = false;
  let forced = false;
  return {
    id,
    kind: "harness",
    phase: "resources",
    cancel: () => {
      cancelled = true;
    },
    dispose: async () => {},
    forceDispose: () => {
      forced = true;
    },
    ...overrides,
    get cancelled() {
      return cancelled;
    },
    get forced() {
      return forced;
    },
  };
}

describe("LifecycleManager", () => {
  it("cancels all resources before disposing ordered phases", async () => {
    const order: string[] = [];
    const manager = new LifecycleManager();
    manager.register(
      resource("listener", {
        phase: "listener",
        cancel: () => order.push("cancel:listener"),
        dispose: async () => {
          order.push("dispose:listener");
        },
      }),
    );
    manager.register(
      resource("sse", {
        phase: "connections",
        cancel: () => order.push("cancel:sse"),
        dispose: async () => {
          order.push("dispose:sse");
        },
      }),
    );
    manager.register(
      resource("session", {
        phase: "activity",
        cancel: () => order.push("cancel:session"),
        dispose: async () => {
          order.push("dispose:session");
        },
      }),
    );
    manager.register(
      resource("runner", {
        phase: "resources",
        cancel: () => order.push("cancel:runner"),
        dispose: async () => {
          order.push("dispose:runner");
        },
      }),
    );

    await manager.dispose(1000);

    expect(order).toEqual([
      "cancel:listener",
      "cancel:sse",
      "cancel:session",
      "cancel:runner",
      "dispose:sse",
      "dispose:session",
      "dispose:runner",
      "dispose:listener",
    ]);
  });

  it("cancels and disposes resources concurrently", async () => {
    const manager = new LifecycleManager();
    const first = manager.register(resource("first"));
    const second = manager.register(resource("second"));

    await manager.dispose(1000);

    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(true);
  });

  it("collects one resource failure without blocking others", async () => {
    const manager = new LifecycleManager();
    const working = manager.register(resource("working"));
    manager.register(
      resource("failing", {
        dispose: async () => {
          throw new Error("boom");
        },
      }),
    );

    const error = await manager.dispose(1000).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LifecycleDisposeError);
    expect(working.cancelled).toBe(true);
    expect((error as LifecycleDisposeError).report.failed).toHaveLength(1);
    expect((error as LifecycleDisposeError).report.failed[0]).toMatchObject({
      id: "failing",
      stage: "dispose",
      error: "boom",
    });
  });

  it("forces unfinished resources after the global deadline", async () => {
    vi.useFakeTimers();
    try {
      const manager = new LifecycleManager();
      const slow = manager.register(
        resource("slow", {
          dispose: () => new Promise<void>(() => {}),
        }),
      );
      const dispose = manager.dispose(20).catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(20);
      const error = await dispose;

      expect(slow.forced).toBe(true);
      expect(error).toBeInstanceOf(LifecycleDisposeError);
      expect((error as LifecycleDisposeError).report.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent and returns the same dispose result", async () => {
    const manager = new LifecycleManager();
    manager.register(
      resource("failing", {
        dispose: async () => {
          throw new Error("boom");
        },
      }),
    );

    const first = manager.dispose(1000).catch((error: unknown) => error);
    const second = manager.dispose(1000).catch((error: unknown) => error);

    await expect(first).resolves.toBe(await second);
  });

  it("rejects registration after shutdown starts", async () => {
    const manager = new LifecycleManager();
    manager.cancel();

    expect(() => manager.register(resource("late"))).toThrow(
      "cannot register a resource after lifecycle shutdown starts",
    );
  });

  it("uses a ten second default shutdown budget", async () => {
    const manager = new LifecycleManager();
    let seenRemaining = Number.POSITIVE_INFINITY;
    manager.register(
      resource("deadline", {
        dispose: async (deadline) => {
          seenRemaining = deadline.remainingMs();
        },
      }),
    );

    await manager.dispose();

    expect(seenRemaining).toBeLessThanOrEqual(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });
});
