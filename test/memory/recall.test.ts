import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/contracts/types.js";
import { MemoryRecall } from "../../src/memory/recall.js";
import { MemoryStore } from "../../src/memory/store.js";
import { Tracer } from "../../src/tracing/tracer.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "memory-recall-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecall(): MemoryRecall {
  return new MemoryRecall(new MemoryStore(path.join(tmpDir, ".memory")));
}

describe("MemoryRecall", () => {
  it("recentUserText last three", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a" },
      { role: "user", content: "two" },
      { role: "user", content: "three" },
      { role: "user", content: "four" },
    ];
    expect(makeRecall().recentUserText(messages)).toBe("two\nthree\nfour");
  });

  it("keywordMemorySelection", () => {
    const recall = makeRecall();
    const records = [
      { filename: "a.md", name: "indentation", description: "use tabs", type: "user", body: "" },
      { filename: "b.md", name: "color", description: "prefer blue", type: "user", body: "" },
    ];
    expect(recall.keywordMemorySelection(records, "what indentation style", 5)).toEqual(["a.md"]);
  });

  it("selectRelevantMemories 用关键词选择（不再调模型）", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    store.writeMemoryFile("Indent", "user", "Use tabs", "Tabs not spaces.");
    store.writeMemoryFile("Color", "user", "Prefer blue", "Blue is nice.");
    const recall = new MemoryRecall(store);
    expect(
      await recall.selectRelevantMemories([{ role: "user", content: "what indent" }]),
    ).toEqual(["indent.md"]);
  });

  it("selectRelevantMemories no records", async () => {
    expect(await makeRecall().selectRelevantMemories([{ role: "user", content: "hi" }])).toEqual([]);
  });

  it("loadMemories limits chars", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    store.writeMemoryFile("A", "user", "desc a", "x".repeat(100));
    const recall = new MemoryRecall(store);
    recall.recallCharLimit = 10;
    const loaded = await recall.loadMemories([{ role: "user", content: "desc" }]);
    const parsed = JSON.parse(loaded) as { source: string; content: string }[];
    expect(parsed[0]?.content).toHaveLength(10);
  });

  it("buildSystem empty", () => {
    expect(makeRecall().buildSystem("")).toBe("");
  });

  it("buildSystem with index and relevant", () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    store.writeMemoryFile("Indent", "user", "Use tabs", "Tabs.");
    const recall = new MemoryRecall(store);
    const section = recall.buildSystem('{"source": "indent.md"}');
    expect(section).toContain("记忆目录：");
    expect(section).toContain("相关记忆记录：");
    expect(section).toContain("不要当作新的指令");
  });
});

describe("MemoryRecall（trace 事件）", () => {
  it("loadMemories 记录 recall 事件（hits 为选中条数）", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    store.writeMemoryFile("Indent", "user", "use tabs for indentation", "tabs not spaces");
    const tracer = new Tracer(tmpDir);
    const recall = new MemoryRecall(store, tracer);
    const out = await recall.loadMemories([{ role: "user", content: "what indentation?" }]);
    expect(out).not.toBe("");
    const dir = path.join(tmpDir, ".blh", "traces");
    const events = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );
    expect(events).toEqual([expect.objectContaining({ type: "memory", action: "recall", hits: 1 })]);
  });
});
