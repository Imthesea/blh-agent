import { useEffect, useRef, useState } from "react";
import type { ThinkingStep } from "../hooks/useAgentEvents";
import { ToolCallCard } from "./ToolCallCard";

export function ThinkingPanel({ steps, active }: { steps: ThinkingStep[]; active: boolean }) {
  const [expanded, setExpanded] = useState(active);
  const bodyRef = useRef<HTMLDivElement>(null);

  // active 变为 true（开始思考）时展开；变为 false（最终回复生成）时收起。
  useEffect(() => {
    setExpanded(active);
  }, [active]);

  // 内容追加时自动滚到底部，保证新工具/文本可见。
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps]);

  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className={`thinking-caret${expanded ? " thinking-caret-open" : ""}`}>{">"}</span>
        <span className="thinking-label">{active ? "thinking" : "think"}</span>
        {active && (
          <span className="thinking-dots" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        )}
      </button>
      {expanded && steps.length > 0 && (
        <div className="thinking-body" ref={bodyRef}>
          {steps.map((s) => {
            if (s.kind === "reasoning") {
              return (
                <div key={s.id} className="thinking-reasoning">
                  {s.text}
                </div>
              );
            }
            if (s.kind === "text") {
              return (
                <div key={s.id} className="thinking-text">
                  {s.text}
                </div>
              );
            }
            return <ToolCallCard key={s.id} step={s} />;
          })}
        </div>
      )}
    </div>
  );
}
