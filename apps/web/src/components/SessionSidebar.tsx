import { useEffect, useRef, useState } from "react";
import type { SessionListItem } from "@blh/web-client";
import { BlhLogo } from "./Logo";
import { IconEllipsis, IconPlus, IconTrash } from "./icons";

/** 相对时间文案（简体中文短格式）。 */
function timeLabel(mtime: number): string {
  const diff = Date.now() - mtime;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

/** 单条会话行：悬停时时间替换为三点菜单，菜单含「删除」。 */
function SessionRow(props: {
  session: SessionListItem;
  active: boolean;
  disabled: boolean;
  onOpen(): void;
  onDelete(): void;
}) {
  const { session, active, disabled, onOpen, onDelete } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (anchorRef.current !== null && !anchorRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  return (
    <li className={`session-row${active ? " selected" : ""}${menuOpen ? " menu-open" : ""}`}>
      <button
        type="button"
        className="session-row-main"
        disabled={disabled}
        onClick={onOpen}
      >
        <span className="session-title">{session.preview !== "" ? session.preview : session.file}</span>
        <span className="session-time">{timeLabel(session.mtime)}</span>
      </button>
      <span className="session-actions">
        <div className="menu-anchor" ref={anchorRef}>
          <button
            type="button"
            className="icon-button"
            aria-label="会话操作"
            disabled={disabled}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconEllipsis size={16} />
          </button>
          {menuOpen && (
            <div className="menu-list" role="menu">
              <button
                type="button"
                className="menu-item danger"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                <span className="menu-item-icon"><IconTrash size={16} /></span>
                <span>删除会话</span>
              </button>
            </div>
          )}
        </div>
      </span>
    </li>
  );
}

export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  loading: boolean;
  onNew(): void;
  onResume(file: string): void;
  onDelete(file: string): void;
}) {
  const { sessions, activeId, loading, onNew, onResume, onDelete } = props;
  return (
    <aside className="sidebar">
      <div className="logo-row">
        <button type="button" className="brand" onClick={onNew}>
          <span className="brand-identity">
            <span className="brand-mark"><BlhLogo size={24} /></span>
            <span className="brand-name">blh</span>
          </span>
        </button>
      </div>

      <button type="button" className="new-session" aria-label="新建会话" onClick={onNew} disabled={loading}>
        <IconPlus size={14} />
        <span className="new-session-label">{loading ? "加载中…" : "新建会话"}</span>
      </button>

      <div className="session-region">
        <ul className="session-list">
          {sessions.map((s) => (
            <SessionRow
              key={s.file}
              session={s}
              active={s.file === activeId}
              disabled={loading}
              onOpen={() => onResume(s.file)}
              onDelete={() => onDelete(s.file)}
            />
          ))}
          {sessions.length === 0 && !loading && <li className="session-empty">暂无会话</li>}
        </ul>
      </div>
    </aside>
  );
}
