import { useEffect, useState } from "react";
// 封装与后端 agent 的事件通信，统一管理会话、消息、工具事件等状态
import { useAgentEvents } from "./hooks/useAgentEvents";
// 聊天消息展示面板
import { ChatPanel } from "./components/ChatPanel";
// 底部输入框，用于发送消息
import { InputBar } from "./components/InputBar";
// 工具调用审批弹窗
import { ApprovalModal } from "./components/ApprovalModal";
// 左侧常驻图标栏（主导航）
import { IconRail } from "./components/IconRail";
// 会话列表侧边栏
import { SessionSidebar } from "./components/SessionSidebar";
// 观测页（Overview / Trace / Ops），经 hash 路由切换
import { OverviewPage } from "./components/observe/OverviewPage";
import { TracePage } from "./components/observe/TracePage";
import { OpsPage } from "./components/observe/OpsPage";

/** 监听 location.hash 的轻量路由：聊天为主视图，#/observe/* 切到观测页。 */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/** 会话列表宽度（px），可拖拽调整并持久化到 localStorage。 */
const SIDEBAR_WIDTH_KEY = "blh.sidebar-width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;

function loadSidebarWidth(): number {
  const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : 280;
}

// 应用根组件
export function App() {
  // 从 hook 中获取 agent 相关的全部状态与操作方法
  const state = useAgentEvents();
  // 会话列表是否折叠（图标栏常驻，折叠只收起会话列表）
  const [collapsed, setCollapsed] = useState(false);
  // 会话列表宽度与拖拽状态
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const route = useHashRoute();
  const observePage = route.startsWith("#/observe/") ? route.slice("#/observe/".length) : null;

  /** 拖拽会话列表右边缘调宽，松开后写入 localStorage。 */
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      setSidebarWidth((w) => {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    // 根据折叠/拖拽状态拼接样式类名
    <div
      className={`app${collapsed ? " app-collapsed" : ""}${dragging ? " app-dragging" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <IconRail route={route} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <SessionSidebar
        sessions={state.sessions}
        activeId={state.sessionId}
        loading={state.sessionLoading}
        onNew={() => void state.createSession()}
        onResume={(file) => void state.resume(file)}
        onDelete={(file) => void state.deleteSession(file)}
      />
      {!collapsed && <div className="sidebar-resizer" onPointerDown={onResizeStart} />}
      {observePage === null ? (
        <main className="main">
          <ChatPanel
            messages={state.messages}
            streaming={state.streaming}
            toolEvents={state.toolEvents}
            busy={state.busy}
            approval={state.approval}
          />
          {/* 有错误时在顶部显示错误横幅 */}
          {state.error !== null && <div className="error-banner">{state.error}</div>}
          <InputBar
            busy={state.busy}
            canStop={state.canStop}
            onSend={(text) => void state.send(text)}
            onStop={() => void state.stop()}
          />
        </main>
      ) : (
        <main className="main observe-main">
          {observePage === "trace" ? <TracePage /> : observePage === "ops" ? <OpsPage /> : <OverviewPage />}
        </main>
      )}
      <ApprovalModal approval={state.approval} onRespond={(d) => void state.respond(d)} />
    </div>
  );
}
