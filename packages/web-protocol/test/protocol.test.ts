import { describe, expect, it } from "vitest";
import {
  WEB_EVENT_TYPES,
  type ChatMessage,
  type SessionInfo,
  type SessionIdResponse,
  type SessionListItem,
  type SessionListResponse,
  type SessionMessagesResponse,
  type WebEvent,
} from "../src/index.js";

describe("web protocol", () => {
  it("keeps the wire event types stable", () => {
    expect([...WEB_EVENT_TYPES]).toEqual([
      "turn_start",
      "assistant_text_delta",
      "assistant_text_complete",
      "tool_call",
      "tool_result",
      "turn_cancelled",
      "turn_end",
      "approval_requested",
      "agent_error",
    ]);
  });

  it("keeps event payloads serializable without transformation", () => {
    const events: WebEvent[] = [
      { type: "turn_start" },
      { type: "assistant_text_delta", text: "hello" },
      { type: "assistant_text_complete", text: "hello" },
      { type: "tool_call", id: "call_1", name: "bash", arguments: "{}" },
      {
        type: "tool_result",
        id: "call_1",
        name: "bash",
        output: "done",
        isError: false,
      },
      { type: "turn_cancelled", text: "cancelled" },
      { type: "turn_end" },
      {
        type: "approval_requested",
        requestId: "request_1",
        tool: "bash",
        target: "ls",
        args: { command: "ls" },
      },
      { type: "agent_error", message: "failed" },
    ];

    expect(events.map((event) => JSON.parse(JSON.stringify(event)))).toEqual(events);
  });

  it("keeps session and message DTO fields stable", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: "{}" },
        },
      ],
      cancelled: true,
    };
    const session: SessionInfo = {
      sessionId: "session_1",
      workdir: "/tmp/project",
      messages: [message],
    };
    const sessionItem: SessionListItem = {
      file: "session_1.jsonl",
      mtime: 1000,
      preview: "hello",
    };
    const sessionList: SessionListResponse = { sessions: [sessionItem] };
    const sessionMessages: SessionMessagesResponse = {
      file: "session_1.jsonl",
      messages: [message],
    };
    const sessionId: SessionIdResponse = { sessionId: "session_1" };

    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    expect(JSON.parse(JSON.stringify(session))).toEqual(session);
    expect(JSON.parse(JSON.stringify(sessionItem))).toEqual(sessionItem);
    expect(JSON.parse(JSON.stringify(sessionList))).toEqual(sessionList);
    expect(JSON.parse(JSON.stringify(sessionMessages))).toEqual(sessionMessages);
    expect(JSON.parse(JSON.stringify(sessionId))).toEqual(sessionId);
  });
});
