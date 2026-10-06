import { describe, expect, it } from "vitest";
import type { ChatProvider, Config } from "../../src/contracts/types.js";
import { HookBus } from "../../src/runtime/hooks.js";
import { agentLoop, runAgentLoop } from "../../src/runtime/loop.js";
import type { AgentLoopRuntime } from "../../src/runtime/ports.js";
import { Transcript } from "../../src/session/transcript.js";

const config: Config = {
  apiKey: "test-key",
  model: "test-model",
  workdir: ".",
  bashTimeout: 120,
  maxOutputChars: 30_000,
};

describe("runtime boundaries", () => {
  it("runs agentLoop with only the runtime port", async () => {
    const provider: ChatProvider = {
      chat: async () => ({ role: "assistant", content: "port ok" }),
    };
    const runtime: AgentLoopRuntime = {
      systemPrompt: "system",
      config,
      provider,
      tools: {
        list: () => [],
        dispatch: async (name) => `error: unknown tool '${name}'`,
      },
      hooks: new HookBus(),
    };
    const transcript = new Transcript({ system: { role: "system", content: runtime.systemPrompt } });
    transcript.append({ role: "user", content: "go" });

    await agentLoop(runtime, transcript, "go");

    expect(transcript.lastAssistantTextAfter(0)).toBe("port ok");
  });

  it("supports a one-turn profile with a custom tool dispatcher", async () => {
    const provider: ChatProvider = {
      chat: async () => ({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "custom", arguments: "{}" },
          },
        ],
      }),
    };
    const runtime: AgentLoopRuntime = {
      systemPrompt: "system",
      config,
      provider,
      tools: {
        list: () => [],
        dispatch: async () => "error: should use profile dispatcher",
      },
      hooks: new HookBus(),
    };
    const transcript = new Transcript({ system: { role: "system", content: runtime.systemPrompt } });
    transcript.append({ role: "user", content: "go" });

    const result = await runAgentLoop(runtime, transcript, "go", undefined, undefined, {
      maxTurns: 1,
      dispatchTool: async ({ call }) => `dispatched:${call.function.name}`,
    });

    expect(result).toEqual({
      status: "max_turns",
      iterations: 1,
      finalAssistant: transcript.messages[2],
    });
    expect(transcript.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "dispatched:custom",
    });
  });
});
