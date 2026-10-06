import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "../contracts/types.js";

/** 会话文件的唯一读写入口：单一 JSONL 文件持续 append，与压缩解耦。 */
export class SessionStore {
  private static seq = 0;

  private constructor(readonly path: string) {}

  static sessionsDir(workdir: string): string {
    return path.join(workdir, ".sessions");
  }

  /** 新建 .sessions/session_<now>_<seq>.jsonl，返回持有该文件的实例。 */
  static create(workdir: string): SessionStore {
    const dir = SessionStore.sessionsDir(workdir);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `session_${Date.now()}_${SessionStore.seq++}.jsonl`);
    appendFileSync(filePath, "", "utf8");
    return new SessionStore(filePath);
  }

  /** 打开已有文件（append 模式；appendFileSync 无持久句柄，无需 close）。 */
  static open(filePath: string): SessionStore {
    return new SessionStore(filePath);
  }

  /** 返回 .sessions/ 下 mtime 最新的 .jsonl 路径；无则 null。mtime 并列时按文件名中的时间戳/序号取更晚者。 */
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

  /** 从 session_<timestamp>_<seq>.jsonl 中解析 [timestamp, seq]，用于 mtime 并列时稳定排序。 */
  private static nameOrder(name: string): [number, number] {
    const match = /^session_(\d+)_(\d+)\.jsonl$/.exec(name);
    return match ? [Number(match[1]), Number(match[2])] : [-1, -1];
  }

  /** 删除指定会话文件；文件不存在时静默（幂等）。 */
  static remove(filePath: string): void {
    rmSync(filePath, { force: true });
  }

  /** 逐行 JSON.parse 还原消息数组；空行 / 非法 JSON 行跳过。 */
  static load(filePath: string): ChatMessage[] {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        // 容错：跳过无法解析的行
      }
    }
    return messages;
  }

  /** JSON.stringify + "\n"，appendFileSync 追加。 */
  append(message: ChatMessage): void {
    appendFileSync(this.path, JSON.stringify(message) + "\n", "utf8");
  }
}
