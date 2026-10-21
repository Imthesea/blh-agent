export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields, error?: unknown): void;
  child(name: string): Logger;
}

export interface LogEntry {
  time: Date;
  level: LogLevel;
  module: string;
  message: string;
  fields: LogFields;
  /** 归属会话（文件名，如 session_xxx.jsonl）；可选，仅 file sink 序列化。 */
  sid?: string;
}

export interface LogSink {
  write(entry: LogEntry): void;
}
