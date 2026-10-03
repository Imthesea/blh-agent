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
});
