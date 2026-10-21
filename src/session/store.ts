import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ChatMessage } from "../contracts/types.js";
import { projectMessages, projectSummary, type SessionEvent } from "./transcript.js";

export const CURRENT_SESSION_VERSION = 1;

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
}

export interface LoadedSession {
  header: SessionHeader | null;
  events: SessionEvent[];
}

const EVENT_TYPES = new Set(["message", "compaction", "rollback", "messageCancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionHeader(value: unknown): value is SessionHeader {
  return (
    isRecord(value) &&
    value["type"] === "session" &&
    value["version"] === CURRENT_SESSION_VERSION &&
    typeof value["id"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["createdAt"] === "string"
  );
}

function isSessionEvent(value: unknown): value is SessionEvent {
  return isRecord(value) && typeof value["type"] === "string" && EVENT_TYPES.has(value["type"]);
}

function maxEventSeq(events: readonly SessionEvent[]): number {
  let seq = 0;
  for (const event of events) {
    if (!Number.isInteger(event.seq) || event.seq <= seq) {
      throw new Error(`Session event seq must be increasing: ${event.seq}`);
    }
    seq = event.seq;
  }
  return seq;
}

/** 会话文件的唯一读写入口：单一 JSONL 文件持续 append，与压缩解耦。 */
export class SessionStore {
  private static seq = 0;
  private lastSeq: number;

  private constructor(readonly path: string, lastSeq = 0) {
    this.lastSeq = lastSeq;
  }

  static sessionsDir(workdir: string): string {
    return path.join(workdir, ".sessions");
  }

  /** 新建带 header 的会话文件，返回持有该文件的实例。 */
  static create(workdir: string): SessionStore {
    const dir = SessionStore.sessionsDir(workdir);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `session_${Date.now()}_${SessionStore.seq++}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: randomUUID(),
      cwd: path.resolve(workdir),
      createdAt: new Date().toISOString(),
    };
    appendFileSync(filePath, `${JSON.stringify(header)}\n`, "utf8");
    return new SessionStore(filePath);
  }

  /** 打开已有文件并预加载最大事件 seq，供 appendEvent 校验使用。 */
  static open(filePath: string): SessionStore {
    const session = SessionStore.loadSession(filePath);
    return new SessionStore(filePath, maxEventSeq(session.events));
  }

  /** 返回 .sessions/ 下 mtime 最新的 .jsonl 路径；无则 null。 */
  static latest(workdir: string): string | null {
    const dir = SessionStore.sessionsDir(workdir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const files = names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
    if (files.length === 0) return null;
    files.sort((a, b) => {
      const byMtime = statSync(b).mtimeMs - statSync(a).mtimeMs;
      if (byMtime !== 0) return byMtime;
      const [ta, sa] = SessionStore.nameOrder(path.basename(a));
      const [tb, sb] = SessionStore.nameOrder(path.basename(b));
      return tb - ta || sb - sa;
    });
    return files[0]!;
  }

  private static nameOrder(name: string): [number, number] {
    const match = /^session_(\d+)_(\d+)\.jsonl$/.exec(name);
    return match ? [Number(match[1]), Number(match[2])] : [-1, -1];
  }

  /** 删除指定会话文件；文件不存在时静默（幂等）。 */
  static remove(filePath: string): void {
    rmSync(filePath, { force: true });
  }

  /** 读取 header 与事件；非事件行（如 v0 旧格式裸消息）会被跳过。 */
  static loadSession(filePath: string): LoadedSession {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return { header: null, events: [] };
    }

    const parsed: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        parsed.push(JSON.parse(line) as unknown);
      } catch {
        // 容错：跳过无法解析的行
      }
    }

    let header: SessionHeader | null = null;
    let startIndex = 0;
    const first = parsed[0];
    if (isSessionHeader(first)) {
      header = first;
      startIndex = 1;
    }

    const events: SessionEvent[] = [];
    let seq = 0;
    for (let index = startIndex; index < parsed.length; index++) {
      const entry = parsed[index];
      if (!isSessionEvent(entry)) continue;
      if (!Number.isInteger(entry.seq) || entry.seq <= seq) {
        throw new Error(`Session event seq must be increasing: ${entry.seq}`);
      }
      events.push(entry);
      seq = entry.seq;
    }
    return { header, events };
  }

  /** 读取事件并投影为当前消息列表。 */
  static loadMessages(filePath: string): ChatMessage[] {
    return projectMessages(SessionStore.loadSession(filePath).events);
  }

  /** 读取事件并投影出最新压缩摘要；无则 null。 */
  static loadSummary(filePath: string): string | null {
    return projectSummary(SessionStore.loadSession(filePath).events);
  }

  /** 追加一条会话事件；seq 必须严格递增。 */
  appendEvent(event: SessionEvent): void {
    if (!Number.isInteger(event.seq) || event.seq <= this.lastSeq) {
      throw new Error(`Session event seq must be greater than ${this.lastSeq}: ${event.seq}`);
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    this.lastSeq = event.seq;
  }
}
