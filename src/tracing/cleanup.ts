import * as fs from "node:fs";
import * as path from "node:path";

/** 判断一条 JSONL 记录是否属于目标会话：sid 相等，或形如 `<sid>:<子代理>`。 */
function belongsTo(sid: unknown, target: string): boolean {
  return typeof sid === "string" && (sid === target || sid.startsWith(`${target}:`));
}

/** 重写一个 JSONL 文件：保留 keep 返回 true 的行；临时文件 + 原子 rename。 */
function rewriteJsonl(file: string, keep: (entry: Record<string, unknown>) => boolean): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // 读不到就算了
  }
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
    rewriteJsonl(file, (e) => !belongsTo(e["sid"], sid));
  }
  const logsDir = path.join(workdir, ".blh", "logs");
  for (const file of listFiles(logsDir)) {
    const base = path.basename(file);
    if (!base.startsWith("blh-") || !file.endsWith(".log")) continue;
    rewriteJsonl(file, (e) => !belongsTo(e["sid"], sid));
  }
}
