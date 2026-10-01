import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.js";
import {
  DREAM_INTERVAL_MS,
  DREAM_MIN_RECORDS,
  DREAM_RETRY_MS,
  MemoryDream,
  applyDreamTrash,
  restoreMemorySnapshot,
  snapshotMemoryFiles,
  validateDreamOutput,
} from "../../src/memory/dream.js";

let tmpDir: string;
let store: MemoryStore;
let dream: MemoryDream;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "memory-dream-"));
  store = new MemoryStore(path.join(tmpDir, ".memory"));
  dream = new MemoryDream(store);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRecords(n: number): void {
  for (let i = 0; i < n; i++) {
    store.writeMemoryFile(`record ${i}`, "project", `desc ${i}`, `body ${i}`);
  }
  store.rebuildMemoryIndex();
}

describe("MemoryDream.isDue", () => {
  it("记录不足门槛时不得 dream", () => {
    writeRecords(DREAM_MIN_RECORDS - 1);
    expect(dream.isDue()).toBe(false);
  });

  it("无状态文件且记录达标时立即到期", () => {
    writeRecords(DREAM_MIN_RECORDS);
    expect(dream.isDue()).toBe(true);
  });

  it("markAttempt 后进入 1h 重试窗口，不再到期", () => {
    writeRecords(DREAM_MIN_RECORDS);
    dream.markAttempt();
    expect(dream.isDue()).toBe(false);
  });

  it("markSuccess 后 24h 内不到期；状态文件持久化", () => {
    writeRecords(DREAM_MIN_RECORDS);
    dream.markSuccess();
    expect(dream.isDue()).toBe(false);
    const again = new MemoryDream(store);
    expect(again.isDue()).toBe(false);
    const state = JSON.parse(readFileSync(path.join(store.directory, ".dream-state.json"), "utf-8"));
    expect(state.lastSuccess).toBeGreaterThan(0);
  });

  it("距上次成功超过 24h 且距上次尝试超过 1h 时再次到期", () => {
    writeRecords(DREAM_MIN_RECORDS);
    dream.markAttempt();
    const now = Date.now();
    const statePath = path.join(store.directory, ".dream-state.json");
    writeFileSync(statePath, JSON.stringify({ lastAttempt: now - DREAM_RETRY_MS, lastSuccess: now - DREAM_INTERVAL_MS }), "utf-8");
    expect(dream.isDue()).toBe(true);
  });
});

describe("snapshot / restore", () => {
  it("快照回滚：删除新增文件、恢复原文件内容", () => {
    writeRecords(2);
    const snapshot = snapshotMemoryFiles(store);
    writeFileSync(store.memoryPath(`${MemoryStore.memorySlug("record 0")}.md`), "corrupted", "utf-8");
    store.writeMemoryFile("new junk", "project", "d", "b");
    restoreMemorySnapshot(store, snapshot);
    expect(existsSync(store.memoryPath(`${MemoryStore.memorySlug("new junk")}.md`))).toBe(false);
    const restored = store.listMemoryFiles().find((r) => r.name === "record 0");
    expect(restored?.body).toBe("body 0");
    expect(existsSync(path.join(store.directory, "MEMORY.md"))).toBe(true);
  });
});

describe("applyDreamTrash", () => {
  it("按清单删除文件并清理清单本身", () => {
    writeRecords(3);
    const victim = store.listMemoryFiles()[0]!.filename;
    writeFileSync(path.join(store.directory, ".dream-trash"), `${victim}\n`, "utf-8");
    applyDreamTrash(store);
    expect(existsSync(store.memoryPath(victim))).toBe(false);
    expect(existsSync(path.join(store.directory, ".dream-trash"))).toBe(false);
    expect(store.listMemoryFiles()).toHaveLength(2);
  });

  it("拒绝删除 MEMORY.md 与逃逸路径，跳过非法行", () => {
    writeRecords(1);
    writeFileSync(path.join(store.directory, ".dream-trash"), "MEMORY.md\n../evil.md\n\n", "utf-8");
    applyDreamTrash(store);
    expect(existsSync(path.join(store.directory, "MEMORY.md"))).toBe(true);
    expect(existsSync(path.join(store.directory, ".dream-trash"))).toBe(false);
  });

  it("清单不存在时无操作", () => {
    writeRecords(1);
    applyDreamTrash(store);
    expect(store.listMemoryFiles()).toHaveLength(1);
  });
});

describe("validateDreamOutput", () => {
  it("全部记录合法时通过", () => {
    writeRecords(2);
    expect(() => validateDreamOutput(store)).not.toThrow();
  });

  it("存在正文为空的 .md 时抛错", () => {
    writeRecords(1);
    writeFileSync(store.memoryPath("empty.md"), "---\nname: empty\n---\n", "utf-8");
    expect(() => validateDreamOutput(store)).toThrow(/empty/);
  });
});
