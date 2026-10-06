import { describe, it, expect } from "vitest";
import { Diagnostics } from "../../src/contracts/diagnostics.js";

describe("Diagnostics", () => {
  it("重复诊断按 type+path+message 去重，保持首次出现顺序", () => {
    const diagnostics = new Diagnostics();
    diagnostics.push({ type: "error", message: "a", path: "x" });
    diagnostics.push({ type: "error", message: "a", path: "x" });
    diagnostics.push({ type: "error", message: "b", path: "x" });
    diagnostics.push({ type: "error", message: "a" });
    expect(diagnostics.list().map((d) => d.message)).toEqual(["a", "b", "a"]);
  });

  it("hasErrors 只认 error，不认 warning", () => {
    const diagnostics = new Diagnostics();
    diagnostics.push({ type: "warning", message: "w" });
    expect(diagnostics.hasErrors()).toBe(false);
    diagnostics.push({ type: "error", message: "e" });
    expect(diagnostics.hasErrors()).toBe(true);
  });

  it("errors() 与 warnings() 按类型过滤", () => {
    const diagnostics = new Diagnostics();
    diagnostics.push({ type: "warning", message: "w1" });
    diagnostics.push({ type: "error", message: "e1" });
    diagnostics.push({ type: "warning", message: "w2" });
    expect(diagnostics.errors().map((d) => d.message)).toEqual(["e1"]);
    expect(diagnostics.warnings().map((d) => d.message)).toEqual(["w1", "w2"]);
  });

  it("size 返回未去重的总数", () => {
    const diagnostics = new Diagnostics();
    diagnostics.push({ type: "error", message: "a" });
    diagnostics.push({ type: "error", message: "a" });
    expect(diagnostics.size).toBe(2);
    expect(diagnostics.list()).toHaveLength(1);
  });
});