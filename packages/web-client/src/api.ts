import type { ApprovalDecision, ChatMessage, SessionInfo, SessionListItem } from "./types.js";
import { createLogger } from "@blh/logger";

const log = createLogger("web-client.api");

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("x-blh-web", "1");
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.warn("request failed", { path, status: res.status, error: body?.error ?? null });
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getSession(): Promise<SessionInfo> {
  return request<SessionInfo>("/api/session");
}

export async function listSessions(): Promise<SessionListItem[]> {
  return (await request<{ sessions: SessionListItem[] }>("/api/sessions")).sessions;
}

export async function getSessionMessages(file: string): Promise<ChatMessage[]> {
  return (await request<{ messages: ChatMessage[] }>(`/api/sessions/${encodeURIComponent(file)}`)).messages;
}

export function sendMessage(text: string): Promise<unknown> {
  return request("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export function stopMessage(): Promise<unknown> {
  return request("/api/stop", { method: "POST" });
}

export function respondApproval(requestId: string, decision: ApprovalDecision): Promise<unknown> {
  return request("/api/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, decision }),
  });
}

export async function newSession(): Promise<string> {
  return (await request<{ sessionId: string }>("/api/session/new", { method: "POST" })).sessionId;
}

export async function resumeSession(file: string): Promise<string> {
  return (
    await request<{ sessionId: string }>("/api/session/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    })
  ).sessionId;
}

export async function deleteSession(file: string): Promise<unknown> {
  return request("/api/session/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file }),
  });
}
