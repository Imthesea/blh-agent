import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest, LiveStep, UiMessage } from "../hooks/useAgentEvents";
import { groupMessages } from "./turns";
import { ThinkingPanel } from "./ThinkingPanel";

/** 压缩检查点：默认折叠成一条「更早的对话已压缩」，可展开看摘要。 */
function Checkpoint({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="checkpoint">
      <button
        type="button"
        className="checkpoint-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className={`checkpoint-caret${expanded ? " checkpoint-caret-open" : ""}`}>{">"}</span>
        <span>更早的对话已压缩</span>
      </button>
      {expanded && <pre className="checkpoint-body">{summary}</pre>}
    </div>
  );
}

export function ChatPanel(props: {
  messages: UiMessage[];
  steps: LiveStep[];
  busy: boolean;
  approval: ApprovalRequest | null;
}) {
  const { messages, steps, busy, approval } = props;
  const blocks = useMemo(() => groupMessages(messages), [messages]);
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
      {blocks.map((block, i) =>
        block.kind === "checkpoint" ? (
          <Checkpoint key={block.id} summary={block.summary} />
        ) : (
          <div key={block.user?.id ?? block.final?.id ?? `turn-${i}`} className="turn">
            {block.user !== null && (
              <div className="bubble bubble-user">
                <span className="bubble-role">user</span>
                <span className="bubble-text">{block.user.content ?? ""}</span>
              </div>
            )}
            {block.thinking.length > 0 && <ThinkingPanel steps={block.thinking} active={false} />}
            {block.final !== null && (
              <div className="bubble bubble-assistant">
                <span className="bubble-role">assistant</span>
                <span className="bubble-text">
                  {block.final.content ?? ""}
                  {block.final.cancelled ? <span className="cancelled-mark">(已中断)</span> : null}
                </span>
              </div>
            )}
          </div>
        ),
      )}
      {thinking && <ThinkingPanel steps={steps} active={true} />}
    </div>
  );
}
