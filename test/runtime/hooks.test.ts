import { describe, it, expect } from "vitest";
import { HookBus } from "../../src/runtime/hooks.js";
import {
  USER_PROMPT_SUBMIT,
  PRE_TOOL_USE,
  POST_TOOL_USE,
  STOP,
} from "../../src/contracts/hooks.js";

const bashPayload = { name: "bash", input: {} };

describe("HookBus", () => {
  it("exports the 4 event constants", () => {
    expect(USER_PROMPT_SUBMIT).toBe("user_prompt_submit");
    expect(PRE_TOOL_USE).toBe("pre_tool_use");
    expect(POST_TOOL_USE).toBe("post_tool_use");
    expect(STOP).toBe("stop");
  });

  it("triggers registered hooks in order and collects results", async () => {
    const bus = new HookBus();
    const calls: string[] = [];
    bus.register(PRE_TOOL_USE, async () => {
      calls.push("a");
      return null;
    });
    bus.register(PRE_TOOL_USE, async () => {
      calls.push("b");
      return "blocked";
    });
    const results = await bus.trigger(PRE_TOOL_USE, bashPayload);
    expect(calls).toEqual(["a", "b"]);
    expect(results).toEqual([null, "blocked"]);
  });

  it("returns empty array when no hooks registered", async () => {
    const bus = new HookBus();
    await expect(bus.trigger(STOP, {})).resolves.toEqual([]);
  });

  it("firstBlock returns the first non-null result", async () => {
    const bus = new HookBus();
    bus.register(PRE_TOOL_USE, async () => null);
    bus.register(PRE_TOOL_USE, async () => "denied");
    bus.register(PRE_TOOL_USE, async () => "ignored");
    await expect(bus.firstBlock(PRE_TOOL_USE, bashPayload)).resolves.toBe("denied");
  });

  it("firstBlock returns null when all pass", async () => {
    const bus = new HookBus();
    bus.register(PRE_TOOL_USE, async () => null);
    await expect(bus.firstBlock(PRE_TOOL_USE, bashPayload)).resolves.toBeNull();
  });

  it("trigger isolates hook exceptions and records null", async () => {
    const bus = new HookBus();
    bus.register(PRE_TOOL_USE, async () => {
      throw new Error("boom");
    });
    bus.register(PRE_TOOL_USE, async () => "ok");
    await expect(bus.trigger(PRE_TOOL_USE, bashPayload)).resolves.toEqual([null, "ok"]);
  });

  it("firstBlock 对抛错的 hook 失败关闭（阻断而非放行）", async () => {
    const bus = new HookBus();
    bus.register(PRE_TOOL_USE, async () => {
      throw new Error("boom");
    });
    bus.register(PRE_TOOL_USE, async () => "denied");
    const result = await bus.firstBlock(PRE_TOOL_USE, bashPayload);
    expect(result).toContain("denied");
    expect(result).toContain("boom");
  });
});
