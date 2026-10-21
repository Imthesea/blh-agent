import type { ThinkingStep, UiMessage } from "../hooks/useAgentEvents";
import { classifyToolOutcome } from "@blh/web-protocol";

/** 一次用户提问的完整展示块：用户气泡（可能为 null）+ 思考过程 + 最终回复。 */
export interface TurnBlock {
  kind: "turn";
  /** 该轮用户消息；压缩后紧跟的续段没有用户消息，为 null。 */
  user: UiMessage | null;
  /** 该轮最后一条有文本的 assistant 消息；无则 null。 */
  final: UiMessage | null;
  thinking: ThinkingStep[];
}

/** 压缩检查点：折叠成一条「更早的对话已压缩」，可展开看摘要。 */
export interface CheckpointBlock {
  kind: "checkpoint";
  id: string;
  summary: string;
}

export type ConversationBlock = TurnBlock | CheckpointBlock;

/** 把一个消息片段折叠成一个 turn（提取最终回复与思考步骤）。 */
function buildTurn(seg: UiMessage[]): TurnBlock {
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

  let seq = 0;
  const nextId = () => `step-${++seq}`;

  const thinking: ThinkingStep[] = [];
  const pendingTools = new Map<string, ThinkingStep>();
  for (let i = 0; i < body.length; i++) {
    const m = body[i]!;
    if (m.role === "assistant") {
      // 思维链（reasoning_content）无论是不是最终回复，都属于 thinking 面板；先想后说，故排在 content 之前。
      const reasoning = (m.reasoning_content ?? "").trim();
      if (reasoning !== "") {
        thinking.push({ id: nextId(), kind: "reasoning", text: reasoning });
      }
      if (i === finalIdx) continue;
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
        step.isError = classifyToolOutcome(output) !== "ok";
      } else {
        thinking.push({ id: nextId(), kind: "tool", name: m.name ?? "tool", output });
      }
    }
  }

  return { kind: "turn", user, final: finalIdx === -1 ? null : body[finalIdx]!, thinking };
}

/**
 * 把扁平消息按时间顺序投影成「展示块」：
 * - 摘要（summary 参数，来自会话元数据）渲染成最前的折叠检查点；
 * - 用户消息开启一个新 turn；
 * - 内部提醒（isInternal）完全隐藏；
 * - assistant / tool 归入当前 turn。
 */
export function groupMessages(messages: UiMessage[], summary: string | null): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  if (summary !== null) {
    blocks.push({ kind: "checkpoint", id: "checkpoint", summary });
  }
  let current: UiMessage[] | null = null;

  const flush = () => {
    if (current !== null) {
      blocks.push(buildTurn(current));
      current = null;
    }
  };

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (m.isInternal === true) continue;
      flush();
      current = [m];
    } else if (current !== null) {
      current.push(m);
    } else {
      // 会话开头就被压缩、没有用户消息可归属时，挂到一个无用户气泡的 turn。
      current = [m];
    }
  }
  flush();
  return blocks;
}
