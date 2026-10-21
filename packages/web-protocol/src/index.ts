export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  cancelled?: boolean;
  /** 内部提醒（如更新 todo / goal）：仅作为模型上下文，不在对话 UI 显示 */
  isInternal?: boolean;
  /** 稳定消息 id（事件 seq），供前端做稳定 React key */
  id?: string;
}

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_text_complete"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_cancelled"; text: string }
  | { type: "turn_end" };

export type WebEvent =
  | AgentEvent
  | {
      type: "approval_requested";
      requestId: string;
      tool: string;
      target: string;
      args: Record<string, unknown>;
    }
  | { type: "agent_error"; message: string };

export const WEB_EVENT_TYPES = [
  "turn_start",
  "assistant_text_delta",
  "assistant_text_complete",
  "tool_call",
  "tool_result",
  "turn_cancelled",
  "turn_end",
  "approval_requested",
  "agent_error",
] as const;

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export interface SessionInfo {
  sessionId: string | null;
  workdir: string;
  messages: ChatMessage[];
  /** 最新压缩摘要；无则 null。前端渲染为「更早的对话已压缩」折叠条。 */
  summary: string | null;
}

export interface SessionListItem {
  file: string;
  mtime: number;
  preview: string;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
}

export interface SessionMessagesResponse {
  file: string;
  messages: ChatMessage[];
  /** 最新压缩摘要；无则 null。 */
  summary: string | null;
}

export interface SessionIdResponse {
  sessionId: string;
}
