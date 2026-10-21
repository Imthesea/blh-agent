import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchMemory } from "../../src/memory/search.js";
import { MemoryStore } from "../../src/memory/store.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "memory-search-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

function makeStore(): MemoryStore {
  const store = new MemoryStore(path.join(tmpDir, ".memory"));
  store.writeMemoryFile("Indent", "user", "Use tabs", "Tabs not spaces.");
  store.writeMemoryFile("Basketball", "user", "likes playing basketball", "Plays every weekend.");
  return store;
}

describe("searchMemory", () => {
  it("按关键词命中 name/description", () => {
    expect(searchMemory(makeStore(), "tabs")).toContain("indent.md");
    expect(searchMemory(makeStore(), "basketball")).toContain("basketball.md");
  });

  it("也能搜到 body 里的词", () => {
    expect(searchMemory(makeStore(), "weekend")).toContain("basketball.md");
  });

  it("无命中返回占位", () => {
    expect(searchMemory(makeStore(), "nonexistent")).toBe("(no matching memory)");
  });

  it("空关键词返回占位", () => {
    expect(searchMemory(makeStore(), "   ")).toBe("(no keyword)");
  });

  it("max_results 截断结果数", () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    for (const name of ["A", "B", "C"]) {
      store.writeMemoryFile(name, "project", `project ${name}`, `body ${name}`);
    }
    const out = searchMemory(store, "project", 2);
    expect(out.split("## ").length - 1).toBe(2);
  });
});
