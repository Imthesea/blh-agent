import { useEffect, useMemo, useRef } from "react";
import type { ApprovalRequest, ToolEvent, UiMessage } from "../hooks/useAgentEvents";
import { groupMessages, type ThinkingStep } from "./turns";
import { ThinkingPanel } from "./ThinkingPanel";

export function ChatPanel(props: {
  messages: UiMessage[];
  streaming: string;
  toolEvents: ToolEvent[];
  busy: boolean;
  approval: ApprovalRequest | null;
}) {
  const { messages, streaming, toolEvents, busy, approval } = props;
  const turns = useMemo(() => groupMessages(messages), [messages]);
  const panelRef = useRef<HTMLDivElement>(null);

  // 内容变化（发消息 / 流式回复 / 工具调用 / 状态切换）时自动滚到底部
  useEffect(() => {
    const el = panelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, toolEvents, busy]);

  // 流式阶段：工具调用 + 当前流式文字实时映射为思考步骤
  const liveThinking = useMemo<ThinkingStep[]>(() => {
    const steps: ThinkingStep[] = toolEvents.map(
      (t): ThinkingStep => ({
        id: t.id,
        kind: "tool",
        name: t.name,
        arguments: t.arguments,
        ...(t.output !== undefined ? { output: t.output } : {}),
        ...(t.isError !== undefined ? { isError: t.isError } : {}),
      }),
    );
    if (streaming.trim() !== "") {
      steps.push({ id: "live-text", kind: "text", text: streaming });
    }
    return steps;
  }, [toolEvents, streaming]);

  // 审批等待期不显示思考框（此时 busy 仍为 true，但尚未开始思考）
  const thinking = busy && approval === null;

  return (
    <div className="chat-panel" aria-live="polite" ref={panelRef}>
      {turns.map((turn) => (
        <div key={turn.user.id} className="turn">
          <div className="bubble bubble-user">
            <span className="bubble-role">user</span>
            <span className="bubble-text">{turn.user.content ?? ""}</span>
          </div>
          {turn.thinking.length > 0 && <ThinkingPanel steps={turn.thinking} active={false} />}
          {turn.final !== null && (
            <div className="bubble bubble-assistant">
              <span className="bubble-role">assistant</span>
              <span className="bubble-text">
                {turn.final.content ?? ""}
                {turn.final.cancelled ? <span className="cancelled-mark">(已中断)</span> : null}
              </span>
            </div>
          )}
        </div>
      ))}
      {thinking && <ThinkingPanel steps={liveThinking} active={true} />}
    </div>
  );
}
