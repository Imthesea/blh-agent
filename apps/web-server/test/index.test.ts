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
      stop: () => {},
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
});
