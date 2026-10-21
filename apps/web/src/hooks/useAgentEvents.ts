import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectEvents,
  deleteSession as deleteSessionApi,
  getSession,
  listSessions,
  newSession,
  respondApproval,
  resumeSession,
  sendMessage,
  stopMessage,
  type ApprovalDecision,
  type ChatMessage,
  type SessionListItem,
} from "@blh/web-client";
import { createLogger } from "@blh/logger";

const log = createLogger("web.app");

/** 连接中断时展示的提示文案。 */
const RECONNECT_MESSAGE = "连接中断，正在自动重连…";

/** thinking 面板里的一个步骤：中间文本、模型思维链（reasoning），或一次工具调用。live 与落盘重放共用。 */
export interface ThinkingStep {
  id: string;
  kind: "text" | "reasoning" | "tool";
  /** kind === "text" / "reasoning" 时的内容 */
  text?: string;
  /** kind === "tool" 时的工具名 / 参数 / 结果 */
  name?: string;
  arguments?: string;
  output?: string;
  isError?: boolean;
}

/** 待用户处理的审批请求（对应 approval_requested 事件去掉 type）。 */
export interface ApprovalRequest {
  requestId: string;
  tool: string;
  target: string;
  args: Record<string, unknown>;
}

/** 带客户端稳定 id 的聊天消息，用于 React key 与失败回滚。 */
export interface UiMessage extends ChatMessage {
  id: string;
}

let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `msg-${messageSeq}`;
}

let stepSeq = 0;
function nextStepId(): string {
  stepSeq += 1;
  return `step-${stepSeq}`;
}

function toUiMessage(m: ChatMessage): UiMessage {
  return { ...m, id: m.id ?? nextId() };
}

export interface AgentState {
  messages: UiMessage[];
  summary: string | null;
  steps: ThinkingStep[];
  approval: ApprovalRequest | null;
  error: string | null;
  busy: boolean;
  sessionLoading: boolean;
  sessions: SessionListItem[];
  sessionId: string | null;
  workdir: string;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  canStop: boolean;
  respond(decision: ApprovalDecision): Promise<void>;
  createSession(): Promise<void>;
  resume(file: string): Promise<void>;
  deleteSession(file: string): Promise<void>;
}

export function useAgentEvents(): AgentState {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [steps, setSteps] = useState<ThinkingStep[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [workdir, setWorkdir] = useState("");

  const refreshSeq = useRef(0);
  const disposed = useRef(false);
  const reconnecting = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  /** 从服务器取回权威消息与工作目录，并刷新会话列表。 */
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const info = await getSession();
      if (disposed.current || seq !== refreshSeq.current) return;
      setSessionId(info.sessionId);
      setWorkdir(info.workdir);
      setMessages(info.messages.map(toUiMessage));
      setSummary(info.summary);
      void listSessions()
        .then((list) => {
          if (disposed.current || seq !== refreshSeq.current) return;
          setSessions(list);
        })
        .catch((e: unknown) => {
          if (disposed.current || seq !== refreshSeq.current) return;
          log.error("list sessions failed", {}, e);
        });
    } catch (e) {
      if (disposed.current || seq !== refreshSeq.current) return;
      log.error("refresh failed", {}, e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = connectEvents(
      "/api/events",
      (event) => {
        switch (event.type) {
          case "turn_start":
            setSubmitting(false);
            setBusy(true);
            setSteps([]);
            setError(null);
            break;
          case "assistant_text_delta":
            setSteps((prev) => {
              const last = prev[prev.length - 1];
              if (last !== undefined && last.kind === "text") {
                return [...prev.slice(0, -1), { ...last, text: (last.text ?? "") + event.text }];
              }
              return [...prev, { id: nextStepId(), kind: "text", text: event.text }];
            });
            break;
          case "assistant_reasoning_delta":
            setSteps((prev) => {
              const last = prev[prev.length - 1];
              if (last !== undefined && last.kind === "reasoning") {
                return [...prev.slice(0, -1), { ...last, text: (last.text ?? "") + event.text }];
              }
              return [...prev, { id: nextStepId(), kind: "reasoning", text: event.text }];
            });
            break;
          case "assistant_text_complete":
            setSteps((prev) => {
              const last = prev[prev.length - 1];
              if (last !== undefined && last.kind === "text") {
                return [...prev.slice(0, -1), { ...last, text: event.text }];
              }
              return [...prev, { id: nextStepId(), kind: "text", text: event.text }];
            });
            break;
          case "tool_call":
            setSteps((prev) => [
              ...prev,
              { id: `tool-${event.id}`, kind: "tool", name: event.name, arguments: event.arguments },
            ]);
            break;
          case "tool_result":
            setSteps((prev) =>
              prev.map((s) =>
                s.id === `tool-${event.id}` ? { ...s, output: event.output, isError: event.isError } : s,
              ),
            );
            break;
          case "turn_end":
            setBusy(false);
            setSteps([]);
            void refresh();
            break;
          case "turn_cancelled":
            setBusy(false);
            setSteps([]);
            void refresh();
            break;
          case "approval_requested":
            setApproval({
              requestId: event.requestId,
              tool: event.tool,
              target: event.target,
              args: event.args,
            });
            break;
          case "agent_error":
            setError(event.message);
            log.warn("agent error", { message: event.message });
            setSubmitting(false);
            setBusy(false);
            setSteps([]);
            break;
        }
      },
      (status) => {
        if (status === "error") {
          reconnecting.current = true;
          setSubmitting(false);
          setBusy(false);
          setSteps([]);
          setError(RECONNECT_MESSAGE);
        } else {
          // 重连成功后重新拉取权威状态，补回断线期间错过的进度。
          if (reconnecting.current) {
            reconnecting.current = false;
            void refresh();
          }
          setError((prev) => (prev === RECONNECT_MESSAGE ? null : prev));
        }
      },
    );
    return off;
  }, [refresh]);

  const send = useCallback(async (text: string) => {
    const userMessage: UiMessage = { role: "user", content: text, id: nextId() };
    setMessages((ms) => [...ms, userMessage]);
    setError(null);
    setSubmitting(true);
    try {
      await sendMessage(text);
    } catch (e) {
      setSubmitting(false);
      setError(e instanceof Error ? e.message : String(e));
      log.error("send failed", {}, e);
      setMessages((ms) => ms.filter((m) => m.id !== userMessage.id));
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await stopMessage();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      log.error("stop failed", {}, e);
    }
  }, []);

  const respond = useCallback(
    async (decision: ApprovalDecision) => {
      if (approval === null) return;
      const id = approval.requestId;
      setApproval(null);
      try {
        await respondApproval(id, decision);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        log.error("respond failed", {}, e);
        setApproval(approval);
      }
    },
    [approval],
  );

  const createSession = useCallback(async () => {
    setSessionLoading(true);
    try {
      await newSession();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? `新建会话失败：${e.message}` : "新建会话失败");
      log.error("create session failed", {}, e);
    } finally {
      setSessionLoading(false);
    }
  }, [refresh]);

  const resume = useCallback(
    async (file: string) => {
      setSessionLoading(true);
      try {
        await resumeSession(file);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? `恢复会话失败：${e.message}` : "恢复会话失败");
        log.error("resume session failed", {}, e);
      } finally {
        setSessionLoading(false);
      }
    },
    [refresh],
  );

  const deleteSession = useCallback(
    async (file: string) => {
      setSessionLoading(true);
      try {
        await deleteSessionApi(file);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? `删除会话失败：${e.message}` : "删除会话失败");
        log.error("delete session failed", {}, e);
      } finally {
        setSessionLoading(false);
      }
    },
    [refresh],
  );

  return {
    messages,
    summary,
    steps,
    approval,
    error,
    busy: busy || submitting,
    sessionLoading,
    sessions,
    sessionId,
    workdir,
    send,
    stop,
    canStop: busy && approval === null,
    respond,
    createSession,
    resume,
    deleteSession,
  };
}
