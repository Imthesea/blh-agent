import * as fs from "node:fs";
import * as path from "node:path";

/** 判断一条 JSONL 记录是否属于目标会话：sid 相等，或形如 `<sid>:<子代理>`。 */
function belongsTo(sid: unknown, target: string): boolean {
  return typeof sid === "string" && (sid === target || sid.startsWith(`${target}:`));
}

/**
 * 重写一个 JSONL 文件：保留 keep 返回 true 的行；临时文件 + 原子 rename。
 * 文件不含目标 sid 时直接跳过（不读过滤、不重写，避免无谓刷 mtime）。
 */
function rewriteJsonl(file: string, sid: string, keep: (entry: Record<string, unknown>) => boolean): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // 读不到就算了
  }
  if (!raw.includes(sid)) return; // 不含目标会话，跳过
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (keep(entry)) kept.push(line);
    } catch {
      kept.push(line); // 坏行保留，不误删
    }
  }
  const content = kept.length > 0 ? kept.join("\n") + "\n" : "";
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // rename 失败（如目标文件正被打开）就放弃本次重写，不阻断删除主流程
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * 删除会话后清理其散落在 trace 与 log 里的行（按 sid / sid 前缀匹配）。
 * 幂等、尽力而为：任何 I/O 失败都吞掉，不阻断会话删除主流程。
 */
export function removeSessionArtifacts(workdir: string, sid: string): void {
  const tracesDir = path.join(workdir, ".blh", "traces");
  for (const file of listFiles(tracesDir)) {
    if (!file.endsWith(".jsonl")) continue;
    rewriteJsonl(file, sid, (e) => !belongsTo(e["sid"], sid));
  }
  const logsDir = path.join(workdir, ".blh", "logs");
  for (const file of listFiles(logsDir)) {
    const base = path.basename(file);
    if (!base.startsWith("blh-") || !file.endsWith(".log")) continue;
    rewriteJsonl(file, sid, (e) => !belongsTo(e["sid"], sid));
  }
}

const TRACE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const LOG_FILE_RE = /^blh-(\d{4}-\d{2}-\d{2})\.log$/;

/** 把 `YYYY-MM-DD` 解析成当地时区当天 0 点的毫秒时间戳；非法返回 NaN。 */
function dayToMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return Number.NaN;
  return new Date(y, m - 1, d).getTime();
}

/**
 * 按文件名日期清理超过 retentionDays 天的 trace/log 文件。
 * 用文件名日期而非 mtime（mtime 会被重写清理刷成「今天」，不可靠）。
 * 返回删除的文件数；I/O 失败静默。
 */
export function pruneOldDailyFiles(workdir: string, retentionDays = 60, now: Date = new Date()): number {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays).getTime();
  const targets: string[] = [];
  for (const file of listFiles(path.join(workdir, ".blh", "traces"))) {
    const m = TRACE_FILE_RE.exec(path.basename(file));
    if (m !== null && dayToMs(m[1]!) < cutoff) targets.push(file);
  }
  for (const file of listFiles(path.join(workdir, ".blh", "logs"))) {
    const m = LOG_FILE_RE.exec(path.basename(file));
    if (m !== null && dayToMs(m[1]!) < cutoff) targets.push(file);
  }
  let removed = 0;
  for (const file of targets) {
    try {
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}
