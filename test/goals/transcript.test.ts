import { describe, expect, it } from "vitest";
import { plainContent, transcriptText } from "../../src/goals/transcript.js";
import type { ChatMessage } from "../../src/contracts/types.js";

describe("transcript", () => {
  it("plain assistant with tool calls", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: "Let me check",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "echo", arguments: '{"x":1}' } },
      ],
    };
    expect(plainContent(message)).toBe('Let me check\n[tool_call echo {"x":1}]');
  });

  it("tool result rendered", () => {
    const message: ChatMessage = { role: "tool", content: "result text", tool_call_id: "c1" };
    expect(plainContent(message)).toBe("[tool_result result text]");
  });

  it("truncates oversized newest drops older", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "older" },
      { role: "assistant", content: "x".repeat(100) },
    ];
    const out = transcriptText(messages, 50);
    expect(out).not.toContain("older");
    expect(out).toContain("x");
  });

  it("keeps recent complete messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "A" },
      { role: "user", content: "B" },
      { role: "user", content: "C" },
    ];
    const out = transcriptText(messages, 20);
    expect(out).toContain("C");
    expect(out).toContain("B");
    expect(out).not.toContain("A");
  });
});
