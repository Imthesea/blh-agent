import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import * as path from "node:path";
import {
  CoreLogger,
  fileDate,
  formatFile,
  formatTerminal,
  isLogLevel,
  LEVEL_ORDER,
  truncateStringFields,
} from "./format.js";
import type { Logger, LogEntry, LogLevel, LogSink } from "./types.js";

export type { LogLevel, LogFields, Logger, LogEntry, LogSink } from "./types.js";
export { formatTerminal, formatFile, isLogLevel } from "./format.js";

let currentLevel: LogLevel = "info";
let logDir: string | null = null;
let currentSid: string | null = null;

/** 短窗口去重：同一 key 在窗口内的重复日志只落第一条，窗口结束补一行 ×N 汇总。 */
const DEDUP_WINDOW_MS = 5000;
/** 只对 warn/error 去重；debug/info 保持实时逐条落盘，避免吞掉有意义的重复 info。 */
const DEDUP_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error"]);

interface PendingDup {
  /** 该 key 已出现次数（含第一条）。 */
  count: number;
  lastTime: number;
  entry: LogEntry;
}

const pendingDup = new Map<string, PendingDup>();
let dupTimer: NodeJS.Timeout | null = null;

function parseLevel(value: string | undefined): LogLevel {
  return isLogLevel(value) ? value : "info";
}

export function initLogger(workdir: string, level?: LogLevel): void {
  currentLevel = level ?? parseLevel(process.env.BLH_LOG_LEVEL);
  logDir = path.join(workdir, ".blh", "logs");
  mkdirSync(logDir, { recursive: true });
}

export function resetLogger(): void {
  currentLevel = "info";
  logDir = null;
  currentSid = null;
  pendingDup.clear();
  if (dupTimer !== null) {
    clearTimeout(dupTimer);
    dupTimer = null;
  }
}

/** 设置当前会话 sid；file sink 落盘时会把该 sid 附加到每条日志行。传 null 清除。 */
export function setLogSid(sid: string | null): void {
  currentSid = sid;
}

function dedupKey(entry: LogEntry): string {
  const fields = JSON.stringify(truncateStringFields(entry.fields));
  return `${entry.level}\u0000${entry.module}\u0000${entry.message}\u0000${entry.sid ?? ""}\u0000${fields}`;
}

function appendLine(filePath: string, line: string): void {
  appendFile(filePath, line, "utf8").catch(() => {
    // 写文件失败降级：静默忽略，避免日志写入本身成为崩溃源
  });
}

function writeSummary(pending: PendingDup): void {
  if (logDir === null || pending.count <= 1) return;
  const summary: LogEntry = {
    time: new Date(pending.lastTime),
    level: pending.entry.level,
    module: pending.entry.module,
    message: `${pending.entry.message}（重复 ${pending.count - 1} 次）`,
    fields: {},
  };
  const filePath = path.join(logDir, `blh-${fileDate(summary.time)}.log`);
  appendLine(filePath, formatFile(summary));
}

/** 把已过窗口的悬挂去重条目写成 ×N 汇总并清空。 */
function flushExpiredDup(now: number): void {
  for (const [key, pending] of [...pendingDup]) {
    if (now - pending.lastTime >= DEDUP_WINDOW_MS) {
      writeSummary(pending);
      pendingDup.delete(key);
    }
  }
}

/** 立即把所有悬挂的去重条目写成 ×N 汇总（窗口未到也写）。测试与显式 flush 用。 */
export function flushPendingDedup(): void {
  for (const [key, pending] of [...pendingDup]) {
    writeSummary(pending);
    pendingDup.delete(key);
  }
  if (dupTimer !== null) {
    clearTimeout(dupTimer);
    dupTimer = null;
  }
}

function scheduleDupFlushAt(at: number): void {
  if (dupTimer !== null) clearTimeout(dupTimer);
  dupTimer = setTimeout(() => {
    dupTimer = null;
    flushExpiredDup(Date.now());
  }, Math.max(0, at - Date.now()));
}

function writeEntryToFile(rawEntry: LogEntry): void {
  if (logDir === null) return;
  const entry: LogEntry =
    rawEntry.sid === undefined && currentSid !== null ? { ...rawEntry, sid: currentSid } : rawEntry;
  const now = Date.now();
  flushExpiredDup(now);

  if (DEDUP_LEVELS.has(entry.level)) {
    const key = dedupKey(entry);
    const pending = pendingDup.get(key);
    if (pending !== undefined && now - pending.lastTime < DEDUP_WINDOW_MS) {
      // 窗口内重复：只计数不落盘，窗口结束补一行汇总
      pending.count += 1;
      pending.lastTime = now;
      scheduleDupFlushAt(now + DEDUP_WINDOW_MS);
      return;
    }
    // 首条：正常落盘，登记去重状态
    const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
    appendLine(filePath, formatFile(entry));
    pendingDup.set(key, { count: 1, lastTime: now, entry });
    return;
  }

  const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
  appendLine(filePath, formatFile(entry));
}

export function appendRawEntry(entry: LogEntry): void {
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[currentLevel]) return;
  writeEntryToFile(entry);
}

/** 终端日志的写函数，默认直接写 stderr。CLI REPL 会注入清行重绘逻辑，避免后台日志覆盖 readline 提示符。 */
let terminalWriter: (text: string) => void = (text) => process.stderr.write(text);

/** 替换终端日志写函数（返回旧函数，便于调用方在退出时还原）。 */
export function setTerminalWriter(writer: (text: string) => void): (text: string) => void {
  const previous = terminalWriter;
  terminalWriter = writer;
  return previous;
}

function terminalSink(): LogSink {
  return { write: (entry) => terminalWriter(formatTerminal(entry) + "\n") };
}

function fileSink(): LogSink {
  return { write: writeEntryToFile };
}

export function createLogger(name: string): Logger {
  return new CoreLogger(name, [terminalSink(), fileSink()], () => currentLevel);
}
