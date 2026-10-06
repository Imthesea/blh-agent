import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger } from "@blh/logger";
import { startWebServer } from "../src/index.js";
import type { WebTurnRunner } from "../src/types.js";
import { makeTestSessionStore } from "./helpers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-index-"));
});

afterEach(() => {
  resetLogger();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function makeRunner(): WebTurnRunner {
  return {
    newSession: () => [],
    runTurn: async () => {},
    jobs: {
      agentLock: { withLock: async <T,>(fn: () => Promise<T>) => fn() },
      start: () => {},
      stop: async () => {},
      abortBackground: () => {},
      setDreamTurn: () => {},
    },
    isDreamDue: async () => false,
    runDreamTurn: async () => {},
  };
}

describe("startWebServer", () => {
  it("validates the port before building the runner", async () => {
    let built = false;
    await expect(
      startWebServer({
        workdir: tmpDir,
        port: 70000,
        staticDir: null,
        sessionStore: makeTestSessionStore(),
        buildHarness: () => {
          built = true;
          return makeRunner();
        },
      }),
    ).rejects.toThrow("port must be an integer between 1 and 65535");
    expect(built).toBe(false);
  });

  it("uses BLH_WEB_PORT when no explicit port is provided", async () => {
    const port = await freePort();
    vi.stubEnv("BLH_WEB_PORT", String(port));
    const running = await startWebServer({
      workdir: tmpDir,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => makeRunner(),
    });
    try {
      expect(running.port).toBe(port);
      expect(running.url).toBe(`http://127.0.0.1:${port}`);
      const response = await fetch(`${running.url}/api/not-found`);
      expect(response.status).toBe(404);
    } finally {
      await running.close();
    }
  });
  it("close awaits the runner dispose hook", async () => {
    const port = await freePort();
    let disposed = false;
    const runner = makeRunner();
    runner.dispose = async () => {
      disposed = true;
    };
    const running = await startWebServer({
      workdir: tmpDir,
      port,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => runner,
    });
    await running.close();
    expect(disposed).toBe(true);
  });
  it("close stops jobs when no dispose hook exists", async () => {
    const port = await freePort();
    let stopped = false;
    const runner = makeRunner();
    runner.jobs!.stop = async () => {
      stopped = true;
    };
    const running = await startWebServer({
      workdir: tmpDir,
      port,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => runner,
    });
    await running.close();
    expect(stopped).toBe(true);
  });
  it("close still closes the server when dispose fails", async () => {
    const port = await freePort();
    const runner = makeRunner();
    runner.dispose = async () => {
      throw new Error("dispose failed");
    };
    const running = await startWebServer({
      workdir: tmpDir,
      port,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => runner,
    });
    await expect(running.close()).rejects.toThrow("dispose failed");
    await expect(fetch(running.url)).rejects.toThrow();
  });

  it("close is idempotent", async () => {
    const port = await freePort();
    const running = await startWebServer({
      workdir: tmpDir,
      port,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => makeRunner(),
    });

    const first = running.close();
    const second = running.close();
    expect(second).toBe(first);
    await first;
  });

  it("close disconnects SSE clients", async () => {
    const port = await freePort();
    const running = await startWebServer({
      workdir: tmpDir,
      port,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => makeRunner(),
    });
    const response = await fetch(`${running.url}/api/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toContain(": connected");

    const closed = running.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    await closed;
  });

  it("close cancels and waits for the current turn", async () => {
    const port = await freePort();
    const runner = makeRunner();
    let started = false;
    let aborted = false;
    runner.runTurn = async (_messages, _text, _events, signal) => {
      started = true;
      if (signal === undefined) throw new Error("expected an abort signal");
      return new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    };
    const running = await startWebServer({
      workdir: tmpDir,
      port,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => runner,
    });
    await fetch(`${running.url}/api/session/new`, {
      method: "POST",
      headers: { "x-blh-web": "1" },
    });
    const response = await fetch(`${running.url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ text: "long task" }),
    });
    expect(response.status).toBe(202);
    expect(started).toBe(true);

    await running.close();
    expect(aborted).toBe(true);
  });

  it("close stops accepting requests before releasing the runner", async () => {
    const port = await freePort();
    const runner = makeRunner();
    let releaseDispose!: () => void;
    runner.dispose = () =>
      new Promise<void>((resolve) => {
        releaseDispose = resolve;
      });
    const running = await startWebServer({
      workdir: tmpDir,
      port,
      staticDir: null,
      sessionStore: makeTestSessionStore(),
      buildHarness: () => runner,
    });

    const closed = running.close();
    const lateStatus = await fetch(`${running.url}/api/session`)
      .then((response) => response.status)
      .catch(() => undefined);

    expect(lateStatus === undefined || lateStatus === 503).toBe(true);
    releaseDispose();
    await closed;
  });

  it("cleans the runner when startup fails", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    let disposed = false;
    const runner = makeRunner();
    runner.dispose = async () => {
      disposed = true;
    };

    await expect(
      startWebServer({
        workdir: tmpDir,
        port,
        staticDir: null,
        sessionStore: makeTestSessionStore(),
        buildHarness: () => runner,
      }),
    ).rejects.toThrow();
    expect(disposed).toBe(true);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("cleans the runner when harness setup fails", async () => {
    const runner = makeRunner();
    runner.jobs = undefined;
    let disposed = false;
    runner.dispose = async () => {
      disposed = true;
    };

    await expect(
      startWebServer({
        workdir: tmpDir,
        staticDir: null,
        sessionStore: makeTestSessionStore(),
        buildHarness: () => runner,
      }),
    ).rejects.toThrow("web server requires a harness with an agent lock");
    expect(disposed).toBe(true);
  });
});
