import { useCallback, useEffect, useRef, useState } from "react";
import {
  listSessions,
  traceApi,
  type FoldedTurn,
  type SessionListItem,
  type TraceEvent,
} from "@blh/web-client";

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 单次 LLM 迭代行。 */
function LlmRow(props: { e: TraceEvent }) {
  const { e } = props;
  const usage = e.usage as { promptTokens?: number; completionTokens?: number } | null | undefined;
  const tokens =
    usage !== null && usage !== undefined
      ? `${usage.promptTokens ?? 0}+${usage.completionTokens ?? 0} tokens`
      : "—";
  return (
    <div className={`trace-llm-row trace-row${e.status === "error" ? " is-error" : ""}`}>
      <span className="trace-dot" />
      <span className="trace-kind">LLM</span>
      <span className="trace-main">
        {str(e.model)}
        <span className="trace-sub">{tokens} · {num(e.latency_ms) !== null ? `${num(e.latency_ms)}ms` : "—"}</span>
      </span>
      {e.status === "error" ? <span className="trace-badge danger">失败</span> : null}
    </div>
  );
}

/** 单次工具调用行，点击展开输出摘要。 */
function ToolRow(props: { e: TraceEvent }) {
  const { e } = props;
  const [open, setOpen] = useState(false);
  const status = str(e.status);
  return (
    <div className="trace-tool-row trace-row">
      <span className={`trace-dot${status === "error" ? " is-error" : status === "denied" ? " is-denied" : ""}`} />
      <span className="trace-kind">TOOL</span>
      <span className="trace-main">
        {str(e.tool)}
        <span className="trace-sub">{str(e.args_summary)} · {num(e.latency_ms) !== null ? `${num(e.latency_ms)}ms` : "—"}</span>
      </span>
      {status !== "ok" && status !== "" ? <span className="trace-badge warn">{status}</span> : null}
      {e.output_summary !== undefined && str(e.output_summary) !== "" && (
        <button type="button" className="trace-expand" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "输出"}
        </button>
      )}
      {open && <pre className="trace-output">{str(e.output_summary)}</pre>}
    </div>
  );
}

/** 单个 turn 卡片：标题 + 事件行 + 脚注。 */
function TurnCard(props: { turn: FoldedTurn }) {
  const { turn } = props;
  return (
    <article className="trace-turn">
      <header className="trace-turn-header">
        <span className="trace-turn-msg">{turn.userMessage !== "" ? turn.userMessage : "(空消息)"}</span>
        {!turn.finished ? (
          <span className="trace-badge">进行中</span>
        ) : turn.cancelled ? (
          <span className="trace-badge warn">已取消</span>
        ) : null}
      </header>
      <div className="trace-events">
        {turn.events
          .filter((e) => e.type === "llm" || e.type === "tool" || e.type === "approval")
          .map((e, i) =>
            e.type === "llm" ? (
              <LlmRow key={i} e={e} />
            ) : e.type === "tool" ? (
              <ToolRow key={i} e={e} />
            ) : (
              <div key={i} className="trace-approval">
                <span className={`trace-badge ${e.decision === "deny" ? "danger" : ""}`}>
                  审批 {str(e.decision)}
                </span>
                <span className="trace-sub">{str(e.tool)} · {str(e.rule)}</span>
              </div>
            ),
          )}
      </div>
      <footer className="trace-turn-footer">
        {turn.latencyMs !== null ? `${(turn.latencyMs / 1000).toFixed(1)}s` : "—"} · {turn.iterations} 迭代 ·{" "}
        {turn.toolsUsed} 工具 · ${turn.costUsd.toFixed(4)}
      </footer>
    </article>
  );
}

export function TracePage() {
  const [dates, setDates] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [date, setDate] = useState("");
  const [sid, setSid] = useState("");
  const [turns, setTurns] = useState<FoldedTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 上次响应内容：没变化时跳过 setState，避免每秒整页重渲染
  const lastJsonRef = useRef("");

  const load = useCallback(async () => {
    try {
      const next = await traceApi.turns({ date, sid });
      const json = JSON.stringify(next);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setTurns(next);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date, sid]);

  useEffect(() => {
    void traceApi.files().then(setDates).catch(() => {});
    void listSessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Trace</h1>
        <button type="button" className="observe-refresh" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error !== null && <div className="error-banner">{error}</div>}
      <div className="trace-toolbar">
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          <option value="">今天</option>
          {dates.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select value={sid} onChange={(e) => setSid(e.target.value)}>
          <option value="">全部会话</option>
          {sessions.map((s) => (
            <option key={s.file} value={s.file}>{s.file}</option>
          ))}
        </select>
      </div>
      {turns.length === 0 ? (
        <p className="observe-empty">暂无 turn</p>
      ) : (
        <div className="trace-turn-list">
          {turns.map((t) => (
            <TurnCard key={`${t.sid}#${t.turn}`} turn={t} />
          ))}
        </div>
      )}
    </div>
  );
}
