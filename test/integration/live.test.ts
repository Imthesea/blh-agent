import { describe, it, expect } from "vitest";

const LIVE = !!process.env.BLH_LIVE;

describe.skipIf(!LIVE)("live API smoke", () => {
  it("answers a trivial prompt", async () => {
    const { buildHarness } = await import("../../src/cli/buildHarness.js");
    const harness = buildHarness();
    const transcript = harness.newTranscript();
    await harness.runTurn(transcript, "Reply with exactly: pong");
    expect(transcript.lastAssistantTextAfter(0).toLowerCase()).toContain("pong");
  }, 120000);
});
