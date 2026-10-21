import { describe, it, expect } from "vitest";
import {
  sanitizeReplay,
  backfillMissingToolResults,
  dropOrphanToolResults,
  stripMalformedToolCalls,
  BACKFILL_TOOL_RESULT,
} from "../../src/session/sanitize.js";
import type { ChatMessage } from "../../src/contracts/types.js";

function assistantCalls(...ids: string[]): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "bash", arguments: "{}" } })),
  };
}
function toolResult(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

describe("sanitizeReplay", () => {
  it("给缺结果的 tool_call 补合成结果（崩溃恢复，尾部）", () => {
    const out = backfillMissingToolResults([assistantCalls("a", "b"), toolResult("a", "r1")]);
    expect(out[out.length - 1]).toEqual({
      role: "tool",
      tool_call_id: "b",
      name: "bash",
      content: BACKFILL_TOOL_RESULT,
    });
  });

  it("不修改合法配对", () => {
    const messages = [assistantCalls("a"), toolResult("a", "ok")];
    expect(sanitizeReplay(messages)).toEqual(messages);
  });

  it("去掉孤儿 tool 结果", () => {
    const messages = [toolResult("ghost", "x"), assistantCalls("a"), toolResult("a", "ok")];
    const out = dropOrphanToolResults(messages);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.tool_call_id).toBe("a");
  });

  it("去掉 name 无效的工具调用", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "1", type: "function", function: { name: "", arguments: "{}" } },
          { id: "2", type: "function", function: { name: "ok", arguments: "{}" } },
        ],
      },
    ];
    const out = stripMalformedToolCalls(messages);
    expect(out[0]?.tool_calls).toEqual([
      { id: "2", type: "function", function: { name: "ok", arguments: "{}" } },
    ]);
  });

  it("幂等且不修改入参", () => {
    const messages = [assistantCalls("a")];
    const before = structuredClone(messages);
    const once = sanitizeReplay(messages);
    expect(sanitizeReplay(once)).toEqual(once);
    expect(messages).toEqual(before);
  });

  it("崩溃场景端到端：每个 tool_call 都有结果", () => {
    const out = sanitizeReplay([assistantCalls("a", "b"), toolResult("a", "r1")]);
    expect(out.filter((m) => m.role === "tool")).toHaveLength(2);
  });
});