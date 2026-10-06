import { describe, expect, it } from "vitest";
import { LifecycleManager } from "@blh/lifecycle";
import { Harness } from "../../src/runtime/harness.js";
import type { JobsPort } from "../../src/runtime/ports.js";
import { HookBus } from "../../src/runtime/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { MockProvider } from "../integration/helpers.js";
import type { Config } from "../../src/contracts/types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp/work",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeJobs(): JobsPort {
  return {
    agentLock: {
      withLock: async <T,>(fn: () => Promise<T>) => fn(),
    },
    background: { hasRunning: () => false },
    cron: {
      acknowledge: () => {},
      listJobs: () => [],
      restore: () => {},
    },
    consumeAndInjectCron: () => [],
    injectBackgroundResults: () => 0,
    startBackground: () => "",
    start: () => {},
    setCronTurn: () => {},
    setDreamTurn: () => {},
    abortBackground: () => {},
    stop: async () => {},
  };
}

describe("Harness lifecycle", () => {
  it("delegates disposal to the shared lifecycle manager", async () => {
    const lifecycle = new LifecycleManager();
    const jobs = makeJobs();
    let jobsCancelled = false;
    let jobsDisposed = false;
    let mcpClosed = false;
    let seenRemaining = Number.POSITIVE_INFINITY;

    lifecycle.register({
      id: "jobs",
      kind: "background",
      phase: "resources",
      cancel: () => {
        jobsCancelled = true;
      },
      dispose: async (deadline) => {
        seenRemaining = deadline.remainingMs();
        jobsDisposed = true;
      },
      forceDispose: () => {},
    });
    lifecycle.register({
      id: "mcp",
      kind: "mcp",
      phase: "resources",
      cancel: () => {},
      dispose: async () => {
        mcpClosed = true;
      },
      forceDispose: () => {},
    });

    const harness = new Harness(
      config,
      new MockProvider([]),
      new ToolRegistry(),
      new HookBus(),
      undefined,
      undefined,
      undefined,
      jobs,
      undefined,
      {
        systemPromptSection: () => "",
        mcp: { closeAll: async () => {} },
      },
      undefined,
      undefined,
      undefined,
      lifecycle,
    );

    await harness.dispose(20);

    expect(jobsCancelled).toBe(true);
    expect(jobsDisposed).toBe(true);
    expect(mcpClosed).toBe(true);
    expect(seenRemaining).toBeLessThanOrEqual(20);
  });
});
