import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import type {
  ChatMessage,
  SessionEventLike,
  SessionHeaderLike,
  SessionStoreLike,
  SessionStoreModule,
  TranscriptLike,
} from "../src/types.js";

let seq = 0;

const sessionsDir = (workdir: string): string => path.join(workdir, ".sessions");

function makeStore(filePath: string): SessionStoreLike {
  return {
    path: filePath,
    appendEvent(event: SessionEventLike): void {
      appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
    },
  };
}

function readEntries(filePath: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const parsed: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      parsed.push(JSON.parse(line) as unknown);
    } catch {
      // 跳过无法解析的行
    }
  }
  return parsed;
}

function messagesFromEvents(events: readonly SessionEventLike[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    if (event.message !== undefined) messages.push(event.message);
  }
  return messages;
}

/** 构造一个可变的 TranscriptLike，供测试里的 fake runner 使用。 */
export function makeTranscript(events?: readonly SessionEventLike[]): TranscriptLike {
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
  if (events !== undefined) messages.push(...messagesFromEvents(events));
  return {
    get messages() {
      return messages;
    },
    get messagesWithIds() {
      return messages.map((m, i) => ({ ...m, id: `m${i}` }));
    },
    lastSeq: 0,
    systemMessage: { role: "system", content: "sys" },
    get summary() {
      return null;
    },
  };
}

/** 把事件列表投影成消息（不处理压缩/回滚，测试仅追加普通消息）。 */
export function eventsToMessages(events: readonly SessionEventLike[]): ChatMessage[] {
  return messagesFromEvents(events);
}

/** 测试用会话存储：行为对齐根 SessionStore，但独立于根包。 */
export function makeTestSessionStore(): SessionStoreModule {
  return {
    sessionsDir,
    create(workdir) {
      mkdirSync(sessionsDir(workdir), { recursive: true });
      const filePath = path.join(sessionsDir(workdir), `session_${Date.now()}_${seq++}.jsonl`);
      const header: SessionHeaderLike = {
        type: "session",
        version: 1,
        id: "test",
        cwd: workdir,
        createdAt: new Date().toISOString(),
      };
      appendFileSync(filePath, JSON.stringify(header) + "\n", "utf8");
      return makeStore(filePath);
    },
    open(filePath) {
      return makeStore(filePath);
    },
    loadSession(filePath) {
      const parsed = readEntries(filePath);
      let header: SessionHeaderLike | null = null;
      let start = 0;
      const first = parsed[0] as Record<string, unknown> | undefined;
      if (first !== undefined && first["type"] === "session" && first["version"] === 1) {
        header = first as unknown as SessionHeaderLike;
        start = 1;
      }
      const events: SessionEventLike[] = [];
      let next = 0;
      for (let index = start; index < parsed.length; index++) {
        const entry = parsed[index] as Record<string, unknown> | undefined;
        if (entry === undefined) continue;
        if (typeof entry["seq"] === "number" && typeof entry["timestamp"] === "string") {
          const event = entry as unknown as SessionEventLike;
          next = Math.max(next, event.seq);
          events.push(event);
        } else if (header === null && entry["role"] !== undefined) {
          next += 1;
          events.push({
            seq: next,
            timestamp: new Date(0).toISOString(),
            type: "message",
            message: entry as unknown as ChatMessage,
          });
        }
      }
      return { header, events };
    },
    loadMessages(filePath) {
      return messagesFromEvents(this.loadSession(filePath).events);
    },
    loadSummary(filePath) {
      let summary: string | null = null;
      for (const event of this.loadSession(filePath).events) {
        if (event.type === "compaction") {
          summary = event.summary ?? event.message?.content ?? null;
        }
      }
      return summary;
    },
    remove(filePath) {
      rmSync(filePath, { force: true });
    },
    latest(workdir) {
      const dir = sessionsDir(workdir);
      let latestPath: string | null = null;
      let latestMtime = 0;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const p = path.join(dir, name);
        const mtime = statSync(p).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestPath = p;
        }
      }
      return latestPath;
    },
  };
}
