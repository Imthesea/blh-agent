import { useState } from "react";
// 封装与后端 agent 的事件通信，统一管理会话、消息、工具事件等状态
import { useAgentEvents } from "./hooks/useAgentEvents";
// 聊天消息展示面板
import { ChatPanel } from "./components/ChatPanel";
// 底部输入框，用于发送消息
import { InputBar } from "./components/InputBar";
// 工具调用审批弹窗
import { ApprovalModal } from "./components/ApprovalModal";
// 左侧会话列表侧边栏
import { SessionSidebar } from "./components/SessionSidebar";

// 应用根组件
export function App() {
  // 从 hook 中获取 agent 相关的全部状态与操作方法
  const state = useAgentEvents();
  // 侧边栏是否折叠
  const [collapsed, setCollapsed] = useState(false);

  return (
    // 根据折叠状态拼接样式类名，折叠时额外追加 app-collapsed
    <div className={`app${collapsed ? " app-collapsed" : ""}`}>
      <SessionSidebar
        sessions={state.sessions}
        activeId={state.sessionId}
        loading={state.sessionLoading}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onNew={() => void state.createSession()}
        onResume={(file) => void state.resume(file)}
        onDelete={(file) => void state.deleteSession(file)}
      />
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
        <InputBar busy={state.busy} onSend={(text) => void state.send(text)} />
      </main>
      <ApprovalModal approval={state.approval} onRespond={(d) => void state.respond(d)} />
    </div>
  );
}
