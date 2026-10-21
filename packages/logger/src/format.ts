import type { LogEntry, LogFields, Logger, LogLevel, LogSink } from "./types.js";

export const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 单个字段值的最大字符数；超过则截断并追加标记。 */
export const MAX_FIELD_CHARS = 512;

/** 判断一个值是不是合法日志级别。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function terminalTime(date: Date): string {
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${ms}`;
}

export function fileDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/** 截断单个字符串：超长时保留前 max 字符并追加「截断了多少」的标记。 */
export function truncateString(value: string, max = MAX_FIELD_CHARS): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + `…[truncated ${value.length - max} chars]`;
}

/**
 * 把 fields 里所有顶层字符串值截断（保留结构、只动字符串叶子），返回新对象，不修改入参。
 * 供文件落盘与去重 key 使用；终端格式在 formatFields 里对渲染文本整体截断。
 */
export function truncateStringFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? truncateString(value) : value;
  }
  return out;
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const text = truncateString(
        typeof value === "object" && value !== null ? safeStringify(value) : String(value),
      );
      // 值含空白或引号时用双引号包裹并转义，保证单行可解析
      if (/[\s"]/.test(text)) {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `${key}="${escaped}"`;
      }
      return `${key}=${text}`;
    })
    .join(" ");
}

export function formatTerminal(entry: LogEntry): string {
  const suffix = formatFields(entry.fields);
  return `[${terminalTime(entry.time)}] [${entry.level}] [${entry.module}] ${entry.message}` +
    (suffix ? ` ${suffix}` : "");
}

export function formatFile(entry: LogEntry): string {
  try {
    return (
      JSON.stringify({
        time: entry.time.toISOString(),
        level: entry.level,
        module: entry.module,
        msg: entry.message,
        sid: entry.sid,
        fields: truncateStringFields(entry.fields),
      }) + "\n"
    );
  } catch {
    return `[unserializable] ${entry.level} ${entry.module} ${entry.message}\n`;
  }
}

export class CoreLogger implements Logger {
  constructor(
    private readonly name: string,
    private readonly sinks: LogSink[],
    private readonly minLevel: () => LogLevel,
  ) {}

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel()]) return;
    const entry: LogEntry = {
      time: new Date(),
      level,
      module: this.name,
      message,
      fields,
    };
    for (const sink of this.sinks) sink.write(entry);
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields ?? {});
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields ?? {});
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields ?? {});
  }

  error(message: string, fields?: LogFields, error?: unknown): void {
    const merged: LogFields = { ...(fields ?? {}) };
    let finalMessage = message;
    if (error !== undefined) {
      if (error instanceof Error) {
        finalMessage = `${message}: ${error.message}`;
        if (error.stack !== undefined) merged.stack ??= error.stack;
      } else {
        finalMessage = `${message}: ${String(error)}`;
      }
    }
    this.write("error", finalMessage, merged);
  }

  child(name: string): Logger {
    return new CoreLogger(`${this.name}.${name}`, this.sinks, this.minLevel);
  }
}
