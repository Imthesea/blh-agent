import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import * as path from "node:path";
import { CoreLogger, fileDate, formatFile, formatTerminal, isLogLevel, LEVEL_ORDER } from "./format.js";
import type { Logger, LogEntry, LogLevel, LogSink } from "./types.js";

export type { LogLevel, LogFields, Logger, LogEntry, LogSink } from "./types.js";
export { formatTerminal, formatFile, isLogLevel } from "./format.js";

let currentLevel: LogLevel = "info";
let logDir: string | null = null;

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
}

function writeEntryToFile(entry: LogEntry): void {
  if (logDir === null) return;
  const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
  appendFile(filePath, formatFile(entry), "utf8").catch(() => {
    // 写文件失败降级：静默忽略，避免日志写入本身成为崩溃源
  });
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
