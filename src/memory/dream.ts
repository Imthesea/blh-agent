// src/memory/dream.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@blh/logger";
import { INDEX_NAME, type MemoryStore } from "./store.js";

const log = createLogger("memory.dream");

/** 距上次成功的滚动触发间隔：24h。 */
export const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 失败（含被 abort）后的重试间隔：1h。 */
export const DREAM_RETRY_MS = 60 * 60 * 1000;
/** 触发门槛：记忆记录至少这么多条。 */
export const DREAM_MIN_RECORDS = 10;
/** dream 待删文件清单（agent 写入，系统侧机械删除）。 */
export const DREAM_TRASH_NAME = ".dream-trash";
/** dream 状态文件（lastAttempt / lastSuccess 时间戳）。 */
export const DREAM_STATE_NAME = ".dream-state.json";

/** dream 轮注入的用户消息（自主记忆整理，非用户消息）。 */
export const DREAM_PROMPT = [
  "[Scheduled] This is an autonomous memory-consolidation turn (autodream), not a user message.",
  "Tidy the long-term memory directory (.memory/):",
  "- Read MEMORY.md and the memory files, then merge duplicates, fix stale facts, and split oversized notes.",
  "- You may ONLY create or edit files inside .memory/ using write_file / edit_file (paths relative to the workdir).",
  "- To delete a file, append its filename (one per line) to .memory/.dream-trash; the system deletes them mechanically after this turn. Never delete by overwriting with empty content.",
  "- Every remaining .md memory file must keep valid frontmatter (name/description/type) and a non-empty body.",
  "- Do not touch any file outside .memory/. Do not run bash. Do not ask the user anything.",
  "- When finished, reply with a one-line summary of what changed.",
].join("\n");

type DreamState = { lastAttempt: number; lastSuccess: number };

export class MemoryDream {
  constructor(private readonly store: MemoryStore) {}

  private statePath(): string {
    return path.join(this.store.directory, DREAM_STATE_NAME);
  }

  readState(): DreamState {
    try {
      const raw = JSON.parse(readFileSync(this.statePath(), "utf-8")) as Partial<DreamState>;
      return { lastAttempt: Number(raw.lastAttempt) || 0, lastSuccess: Number(raw.lastSuccess) || 0 };
    } catch {
      return { lastAttempt: 0, lastSuccess: 0 };
    }
  }

  private writeState(state: DreamState): void {
    mkdirSync(this.store.directory, { recursive: true });
    writeFileSync(this.statePath(), JSON.stringify(state), "utf-8");
  }

  markAttempt(): void {
    this.writeState({ ...this.readState(), lastAttempt: Date.now() });
  }

  markSuccess(): void {
    const now = Date.now();
    this.writeState({ lastAttempt: now, lastSuccess: now });
  }

  /** 到期条件：记录数达标，且距上次成功 ≥24h、距上次尝试 ≥1h（无状态文件时立即到期）。 */
  isDue(now = Date.now()): boolean {
    if (this.store.listMemoryFiles().length < DREAM_MIN_RECORDS) return false;
    const state = this.readState();
    return now - state.lastSuccess >= DREAM_INTERVAL_MS && now - state.lastAttempt >= DREAM_RETRY_MS;
  }
}

/** 快照所有 .md 记忆文件（含 MEMORY.md）的原始内容。 */
export function snapshotMemoryFiles(store: MemoryStore): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!existsSync(store.directory)) return snapshot;
  for (const fileName of readdirSync(store.directory).filter((f) => f.endsWith(".md"))) {
    try {
      snapshot[fileName] = readFileSync(fileName === INDEX_NAME ? store.indexPath : store.memoryPath(fileName), "utf-8");
    } catch {
      continue;
    }
  }
  return snapshot;
}

/** 回滚：删光当前 .md，写回快照，重建索引。 */
export function restoreMemorySnapshot(store: MemoryStore, snapshot: Record<string, string>): void {
  if (existsSync(store.directory)) {
    for (const fileName of readdirSync(store.directory).filter((f) => f.endsWith(".md"))) {
      try {
        unlinkSync(fileName === INDEX_NAME ? store.indexPath : store.memoryPath(fileName));
      } catch {
        continue;
      }
    }
  }
  for (const [fileName, content] of Object.entries(snapshot)) {
    writeFileSync(fileName === INDEX_NAME ? store.indexPath : store.memoryPath(fileName), content, "utf-8");
  }
  store.rebuildMemoryIndex();
  log.info("dream snapshot restored", { files: Object.keys(snapshot).length });
}

/** 机械执行 .dream-trash 清单：逐行校验文件名（拒绝索引与逃逸），删除后清掉清单并重建索引。 */
export function applyDreamTrash(store: MemoryStore): void {
  const trashPath = path.join(store.directory, DREAM_TRASH_NAME);
  if (!existsSync(trashPath)) return;
  const lines = readFileSync(trashPath, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  let removed = 0;
  for (const line of lines) {
    if (line === INDEX_NAME) continue;
    let target: string;
    try {
      target = store.memoryPath(line);
    } catch {
      log.warn("dream trash skipped invalid entry", { entry: line });
      continue;
    }
    try {
      unlinkSync(target);
      removed += 1;
    } catch {
      continue;
    }
  }
  rmSync(trashPath, { force: true });
  store.rebuildMemoryIndex();
  log.info("dream trash applied", { removed });
}

/** 校验 dream 产出：每个记忆文件正文必须非空。不合法即抛错（调用方据此回滚）。 */
export function validateDreamOutput(store: MemoryStore): void {
  for (const record of store.listMemoryFiles()) {
    if (record.body.trim() === "") {
      throw new Error(`dream produced empty memory file: ${record.filename}`);
    }
  }
}
