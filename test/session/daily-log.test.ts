import { describe, it, expect } from "vitest";
import { renderSessionMarkdown } from "../../src/session/daily-log.js";
import type { ChatMessage } from "../../src/contracts/types.js";

describe("renderSessionMarkdown", () => {
  it("跳过 system 与 isInternal", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", isInternal: true },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    const text = renderSessionMarkdown(messages);
    expect(text).toContain("### user");
    expect(text).toContain("hi");
    expect(text).toContain("### tool [c1]");
    expect(text).toContain("result");
    expect(text).not.toContain("sys");
    expect(text).not.toContain("hello");
  });

  it("渲染带工具调用的 assistant（工具名+参数+正文）", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "done",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "write_file", arguments: '{"path":"a"}' } },
        ],
      },
    ];
    const text = renderSessionMarkdown(messages);
    expect(text).toContain("### assistant");
    expect(text).toContain('write_file({"path":"a"})');
    expect(text).toContain("done");
  });

  it("空列表返回空文档", () => {
    expect(renderSessionMarkdown([])).toBe("\n\n");
  });
});
