export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
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

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** assistant 消息携带的工具调用（来自 JSONL，用于历史折叠成思考框） */
  tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  /** tool 消息关联的工具调用 id */
  tool_call_id?: string;
  /** tool 消息的工具名 */
  name?: string;
  /** 该条 assistant 消息是否因用户中断而停止生成 */
  cancelled?: boolean;
}

export interface SessionInfo {
  sessionId: string | null;
  workdir: string;
  messages: ChatMessage[];
}

export interface SessionListItem {
  file: string;
  mtime: number;
  preview: string;
}
