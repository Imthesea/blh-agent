import { describe, it, expect } from "vitest";
import { TodoManager } from "../../src/planning/todo.js";

describe("TodoManager", () => {
  it("update replaces items and renders", () => {
    const tm = new TodoManager();
    expect(tm.update([{ content: "write code", status: "in_progress" }])).toBe("[~] write code");
    expect(tm.items).toEqual([{ content: "write code", status: "in_progress" }]);
  });

  it("render empty", () => {
    expect(new TodoManager().render()).toBe("No todos.");
  });

  it("render marks by status", () => {
    const tm = new TodoManager();
    tm.update([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
    ]);
    expect(tm.render().split("\n")).toEqual(["[ ] a", "[~] b", "[x] c"]);
  });

  it("update rejects non-list", () => {
    expect(() => new TodoManager().update({ content: "a" })).toThrow("todos must be a list");
  });

  it("update rejects non-object elements", () => {
    expect(() => new TodoManager().update([null])).toThrow("each todo must be an object");
  });

  it("update rejects empty content", () => {
    expect(() => new TodoManager().update([{ content: "  " }])).toThrow("todo content cannot be empty");
  });

  it("update rejects bad status", () => {
    expect(() => new TodoManager().update([{ content: "a", status: "done" }])).toThrow("invalid status");
  });

  it("update rejects too many", () => {
    const tm = new TodoManager();
    const many = Array.from({ length: 21 }, (_, i) => ({ content: String(i), status: "pending" }));
    expect(() => tm.update(many)).toThrow("too many todos");
  });

  it("noteRound counts and resets", () => {
    const tm = new TodoManager();
    tm.update([{ content: "a", status: "pending" }]);
    expect(tm.noteRound(false)).toBeNull(); // 1
    expect(tm.noteRound(false)).toBeNull(); // 2
    expect(tm.noteRound(false)).toBe("<reminder>Update your todos.</reminder>");
    expect(tm.noteRound(false)).toBeNull(); // 重置后回到 1
  });

  it("noteRound 无未完成项时永不提醒", () => {
    const tm = new TodoManager();
    tm.update([{ content: "a", status: "completed" }]);
    for (let i = 0; i < 5; i++) {
      expect(tm.noteRound(false)).toBeNull();
    }
  });

  it("noteRound 空列表永不提醒", () => {
    const tm = new TodoManager();
    for (let i = 0; i < 5; i++) {
      expect(tm.noteRound(false)).toBeNull();
    }
  });

  it("noteRound resets on used todo", () => {
    const tm = new TodoManager();
    tm.update([{ content: "a", status: "pending" }]);
    tm.noteRound(false); // 1
    tm.noteRound(false); // 2
    expect(tm.noteRound(true)).toBeNull(); // 重置
    expect(tm.noteRound(false)).toBeNull(); // 1
  });
});
