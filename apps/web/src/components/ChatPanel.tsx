import { useEffect, useMemo, useRef } from "react";
import type { ApprovalRequest, LiveStep, UiMessage } from "../hooks/useAgentEvents";
import { groupMessages } from "./turns";
import { ThinkingPanel } from "./ThinkingPanel";

export function ChatPanel(props: {
  messages: UiMessage[];
  steps: LiveStep[];
  busy: boolean;
  approval: ApprovalRequest | null;
}) {
  const { messages, steps, busy, approval } = props;
  const turns = useMemo(() => groupMessages(messages), [messages]);
  const panelRef = useRef<HTMLDivElement>(null);

  // 内容变化（发消息 / 流式回复 / 工具调用 / 状态切换）时自动滚到底部
  useEffect(() => {
    const el = panelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, steps, busy]);

  // 审批等待期不显示思考框（此时 busy 仍为 true，但尚未开始思考）
  const thinking = busy && approval === null;

  return (
    <div className="chat-panel" aria-live="polite" ref={panelRef}>
      {turns.map((turn, i) => (
        <div key={turn.user?.id ?? turn.final?.id ?? `turn-${i}`} className="turn">
          {turn.user !== null && (
            <div className="bubble bubble-user">
              <span className="bubble-role">user</span>
              <span className="bubble-text">{turn.user.content ?? ""}</span>
            </div>
          )}
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
      {thinking && <ThinkingPanel steps={steps} active={true} />}
    </div>
  );
}
