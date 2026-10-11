import type { UiMessage } from "../hooks/useAgentEvents";

/** 思考框内的一步：中间文本，或一次工具调用。 */
export interface ThinkingStep {
  id: string;
  kind: "text" | "tool";
  /** kind === "text" 时的内容 */
  text?: string;
  /** kind === "tool" 时的工具名 / 参数 / 结果 */
  name?: string;
  arguments?: string;
  output?: string;
  isError?: boolean;
}

/** 一次用户提问的完整展示块：用户气泡（可能为 null）+ 思考过程 + 最终回复。 */
export interface TurnBlock {
  /** 该轮用户消息；压缩摘要被隐藏后紧跟的续段没有用户消息，为 null。 */
  user: UiMessage | null;
  /** 该轮最后一条有文本的 assistant 消息；无则 null。 */
  final: UiMessage | null;
  thinking: ThinkingStep[];
}

/**
 * 把扁平消息按「用户提问」分段，并把每段里的中间文本 + 工具调用折叠为思考过程，
 * 只保留最后一条有文本的 assistant 作为最终回复。
 * 压缩摘要消息（isCompactionSummary）不展示，也不作为用户轮次。
 */
export function groupMessages(messages: UiMessage[]): TurnBlock[] {
  const segments: UiMessage[][] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (m.isCompactionSummary === true) continue; // 隐藏压缩摘要
      segments.push([m]);
    } else if (segments.length > 0) {
      segments[segments.length - 1]!.push(m);
    } else {
      // 会话开头就被压缩、没有用户消息可归属时，挂到一个无用户气泡的续段，避免丢弃。
      segments.push([m]);
    }
  }

  let seq = 0;
  const nextId = () => `step-${++seq}`;

  return segments.map((seg) => {
    const hasUser = seg[0]!.role === "user";
    const user = hasUser ? seg[0]! : null;
    const body = hasUser ? seg.slice(1) : seg;

    // 找最后一条有文本的 assistant（作为最终回复）
    let finalIdx = -1;
    for (let i = 0; i < body.length; i++) {
      const m = body[i]!;
      if (m.role === "assistant" && ((m.content ?? "").trim() !== "" || m.cancelled === true)) {
        finalIdx = i;
      }
    }

    const thinking: ThinkingStep[] = [];
    const pendingTools = new Map<string, ThinkingStep>();
    for (let i = 0; i < body.length; i++) {
      if (i === finalIdx) continue;
      const m = body[i]!;
      if (m.role === "assistant") {
        const text = (m.content ?? "").trim();
        if (text !== "") {
          thinking.push({ id: nextId(), kind: "text", text });
        }
        for (const call of m.tool_calls ?? []) {
          const step: ThinkingStep = {
            id: nextId(),
            kind: "tool",
            name: call.function.name,
            arguments: call.function.arguments,
          };
          thinking.push(step);
          pendingTools.set(call.id, step);
        }
      } else if (m.role === "tool") {
        const output = m.content ?? "";
        const step = m.tool_call_id ? pendingTools.get(m.tool_call_id) : undefined;
        if (step) {
          step.output = output;
          step.isError = output.startsWith("error:") || output.startsWith("denied");
        } else {
          thinking.push({ id: nextId(), kind: "tool", name: m.name ?? "tool", output });
        }
      }
    }

    return { user, final: finalIdx === -1 ? null : body[finalIdx]!, thinking };
  });
}
