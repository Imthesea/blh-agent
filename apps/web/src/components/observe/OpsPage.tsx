import { useCallback, useEffect, useRef, useState } from "react";
import {
  traceApi,
  type FoldedTurn,
  type TraceEvent,
  type TraceOverview,
  type UsageBucket,
} from "@blh/web-client";

function fmtLatency(ms: number | null): string {
  return ms !== null ? `${(ms / 1000).toFixed(1)}s` : "—";
}

function CostTable(props: { title: string; buckets: Record<string, UsageBucket> }) {
  const rows = Object.entries(props.buckets).sort(([a], [b]) => (a < b ? -1 : 1));
  if (rows.length === 0) return <p className="observe-empty">暂无数据</p>;
  return (
    <section className="observe-section">
      <h2>{props.title}</h2>
      <table className="ops-table">
        <thead>
          <tr><th>名称</th><th>输入 tokens</th><th>输出 tokens</th><th>成本</th></tr>
        </thead>
        <tbody>
          {rows.map(([k, b]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{b.in}</td>
              <td>{b.out}</td>
              <td>${b.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function collectApprovals(turns: FoldedTurn[]): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const t of turns) {
    for (const e of t.events) {
      if (e.type === "approval") out.push(e);
    }
  }
  return out;
}

export function OpsPage() {
  const [overview, setOverview] = useState<TraceOverview | null>(null);
  const [turns, setTurns] = useState<FoldedTurn[]>([]);
  const [raw, setRaw] = useState<TraceEvent[]>([]);
  const [rawTotal, setRawTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // trace 原文的读取位置：首次从尾部开始，之后只增量拉新行
  const cursorRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const [ov, tns, page] = await Promise.all([
        traceApi.overview(),
        traceApi.turns({ limit: 100 }),
        traceApi.eventsTail(200),
      ]);
      setOverview(ov);
      setTurns(tns);
      setRaw(page.events);
      setRawTotal(page.nextCursor);
      cursorRef.current = page.nextCursor;
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // 2 秒增量轮询 trace 原文：没新行时只传一个数字，成本不随文件增长
    const timer = setInterval(() => {
      void (async () => {
        try {
          const page = await traceApi.events(cursorRef.current);
          if (page.events.length > 0) {
            setRaw((prev) => [...prev, ...page.events].slice(-200));
          }
          setRawTotal(page.nextCursor);
          cursorRef.current = page.nextCursor;
        } catch {
          // 轮询失败静默，下一轮重试
        }
      })();
    }, 2000);
    return () => clearInterval(timer);
  }, [load]);

  const approvals = collectApprovals(turns);
  const allowCount = approvals.filter((e) => e.decision === "allow").length;
  const denyCount = approvals.filter((e) => e.decision === "deny").length;
  const slowest = [...turns]
    .filter((t) => t.latencyMs !== null)
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
    .slice(0, 10);

  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Ops</h1>
        <button type="button" className="observe-refresh" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error !== null && <div className="error-banner">{error}</div>}
      {overview === null ? (
        <p className="observe-empty">加载中…</p>
      ) : (
        <>
          <CostTable title="按天" buckets={overview.usage.byDay} />
          <CostTable title="按 provider" buckets={overview.usage.byProvider} />
          <CostTable title="按模型" buckets={overview.usage.byModel} />

          <section className="observe-section">
            <h2>审批决策</h2>
            <div className="ops-approval">
              <span className="trace-badge">allow {allowCount}</span>
              <span className="trace-badge danger">deny {denyCount}</span>
            </div>
            {approvals.length === 0 ? (
              <p className="observe-empty">暂无审批记录</p>
            ) : (
              <table className="ops-table">
                <thead>
                  <tr><th>工具</th><th>决策</th><th>规则</th><th>来源</th></tr>
                </thead>
                <tbody>
                  {approvals.map((e, i) => (
                    <tr key={i}>
                      <td>{typeof e.tool === "string" ? e.tool : "—"}</td>
                      <td>{typeof e.decision === "string" ? e.decision : "—"}</td>
                      <td>{typeof e.rule === "string" ? e.rule : "—"}</td>
                      <td>{typeof e.source === "string" ? e.source : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="observe-section">
            <h2>最慢 10 个 turns</h2>
            {slowest.length === 0 ? (
              <p className="observe-empty">暂无已完成 turn</p>
            ) : (
              <ul className="turn-list ops-slowest">
                {slowest.map((t) => (
                  <li className="turn-row" key={`${t.sid}#${t.turn}`}>
                    <span className="turn-msg">{t.userMessage !== "" ? t.userMessage : "(空消息)"}</span>
                    <span className="turn-meta">{fmtLatency(t.latencyMs)} · ${t.costUsd.toFixed(4)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="observe-section">
            <h2>trace 原文（显示 {raw.length} / 共 {rawTotal} 行）</h2>
            {raw.length === 0 ? (
              <p className="observe-empty">暂无事件</p>
            ) : (
              <pre className="ops-raw">
                {raw.map((e, i) => JSON.stringify(e)).join("\n")}
              </pre>
            )}
          </section>
        </>
      )}
    </div>
  );
}
