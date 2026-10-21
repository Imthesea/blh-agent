import { describe, expect, it } from "vitest";
import { groupMessages } from "./turns";
import type { UiMessage } from "../hooks/useAgentEvents";

let seq = 0;

/** 构造一条 UiMessage：未传的可选字段一律不出现（满足 exactOptionalPropertyTypes）。 */
function msg(p: {
  role: UiMessage["role"];
  content?: string | null;
  id?: string;
  tool_calls?: UiMessage["tool_calls"];
  tool_call_id?: string;
  name?: string;
  cancelled?: boolean;
  isInternal?: boolean;
}): UiMessage {
  const m: UiMessage = { role: p.role, content: p.content ?? null, id: p.id ?? `m${++seq}` };
  if (p.tool_calls !== undefined) m.tool_calls = p.tool_calls;
  if (p.tool_call_id !== undefined) m.tool_call_id = p.tool_call_id;
  if (p.name !== undefined) m.name = p.name;
  if (p.cancelled !== undefined) m.cancelled = p.cancelled;
  if (p.isInternal !== undefined) m.isInternal = p.isInternal;
  return m;
}

function turnAt(blocks: ReturnType<typeof groupMessages>, index: number) {
  const block = blocks[index];
  if (block?.kind !== "turn") throw new Error(`expected turn at ${index}`);
  return block;
}

describe("groupMessages", () => {
  it("摘要渲染成最前的 checkpoint 块", () => {
    const blocks = groupMessages([msg({ role: "user", content: "hi" })], "更早内容已压缩");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "checkpoint", id: "checkpoint", summary: "更早内容已压缩" });
    expect(blocks[1]?.kind).toBe("turn");
  });

  it("无摘要时不产生 checkpoint", () => {
    const blocks = groupMessages([msg({ role: "user", content: "hi" })], null);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("turn");
  });

  it("隐藏 isInternal 的 user 消息，不开启新 turn", () => {
    const blocks = groupMessages(
      [
        msg({ role: "user", content: "real" }),
        msg({ role: "user", content: "提醒", isInternal: true }),
        msg({ role: "assistant", content: "answer" }),
      ],
      null,
    );
    expect(blocks).toHaveLength(1);
    const turn = turnAt(blocks, 0);
    expect(turn.user?.content).toBe("real");
    expect(turn.final?.content).toBe("answer");
  });

  it("跳过 system 消息", () => {
    const blocks = groupMessages(
      [msg({ role: "system", content: "sys" }), msg({ role: "user", content: "hi" })],
      null,
    );
    expect(blocks).toHaveLength(1);
    expect(turnAt(blocks, 0).user?.content).toBe("hi");
  });

  it("工具调用与结果配对进 thinking，并标记错误", () => {
    const blocks = groupMessages(
      [
        msg({ role: "user", content: "run" }),
        msg({
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
        }),
        msg({ role: "tool", tool_call_id: "c1", name: "bash", content: "error: boom" }),
        msg({ role: "assistant", content: "done" }),
      ],
      null,
    );
    const turn = turnAt(blocks, 0);
    expect(turn.thinking).toHaveLength(1);
    const step = turn.thinking[0];
    expect(step?.kind).toBe("tool");
    if (step?.kind !== "tool") throw new Error("expected tool step");
    expect(step.name).toBe("bash");
    expect(step.output).toBe("error: boom");
    expect(step.isError).toBe(true);
    expect(turn.final?.content).toBe("done");
  });

  it("无用户前缀的 assistant 挂到无用户气泡的 turn", () => {
    const blocks = groupMessages([msg({ role: "assistant", content: "orphan" })], null);
    const turn = turnAt(blocks, 0);
    expect(turn.user).toBeNull();
    expect(turn.final?.content).toBe("orphan");
  });

  it("cancelled 且空内容的 assistant 仍作为最终回复", () => {
    const blocks = groupMessages(
      [msg({ role: "user", content: "x" }), msg({ role: "assistant", content: "", cancelled: true })],
      null,
    );
    const turn = turnAt(blocks, 0);
    expect(turn.final?.cancelled).toBe(true);
  });
});
