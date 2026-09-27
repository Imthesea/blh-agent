import { useCallback, useEffect, useState } from "react";
import { traceApi, type TraceOverview } from "@blh/web-client";

/** 近 14 天成本条形图（纯 CSS，无图表依赖）。 */
function CostBars(props: { byDay: Record<string, { costUsd: number }> }) {
  const days = Object.entries(props.byDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-14);
  if (days.length === 0) return <p className="observe-empty">暂无成本数据</p>;
  const max = days.reduce((m, [, b]) => Math.max(m, b.costUsd), 0);
  return (
    <div className="cost-bars">
      {days.map(([day, b]) => (
        <div className="cost-bar-col" key={day} title={`${day} $${b.costUsd.toFixed(4)}`}>
          <div
            className="cost-bar"
            style={{ height: `${max > 0 ? Math.max(2, Math.round((b.costUsd / max) * 100)) : 2}%` }}
          />
          <span className="cost-bar-label">{day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

export function OverviewPage() {
  const [data, setData] = useState<TraceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await traceApi.overview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Overview</h1>
        <button type="button" className="observe-refresh" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error !== null && <div className="error-banner">{error}</div>}
      {data === null ? (
        <p className="observe-empty">加载中…</p>
      ) : (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <span className="stat-label">总花费</span>
              <span className="stat-value">${data.usage.total.costUsd.toFixed(4)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">今日 turns</span>
              <span className="stat-value">{data.today.turns}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">今日工具调用</span>
              <span className="stat-value">{data.today.tools}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">平均延迟</span>
              <span className="stat-value">{(data.today.avgLatencyMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          <section className="observe-section">
            <h2>近 14 天成本</h2>
            <CostBars byDay={data.usage.byDay} />
          </section>

          <section className="observe-section">
            <h2>最近 turns</h2>
            {data.recentTurns.length === 0 ? (
              <p className="observe-empty">今日暂无 turn</p>
            ) : (
              <ul className="turn-list">
                {data.recentTurns.map((t) => (
                  <li className="turn-row" key={`${t.sid}#${t.turn}`}>
                    <span className="turn-msg">{t.userMessage !== "" ? t.userMessage : "(空消息)"}</span>
                    <span className="turn-meta">
                      {t.latencyMs !== null ? `${(t.latencyMs / 1000).toFixed(1)}s` : "—"} · {t.iterations} 迭代 ·{" "}
                      {t.toolsUsed} 工具 · ${t.costUsd.toFixed(4)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
