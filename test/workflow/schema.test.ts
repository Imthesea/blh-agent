import { describe, expect, it } from "vitest";
import {
  SimpleJsonSchema,
  WorkflowInputError,
  parseRunnerJson,
  stableHash,
} from "../../src/workflow/schema.js";

describe("workflow schema", () => {
  it("stable hash is process independent", () => {
    const a = stableHash("hello");
    const b = stableHash("hello");
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0n);
    expect(stableHash("world")).not.toBe(a);
  });

  it("schema object required", () => {
    const schema = new SimpleJsonSchema({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    });
    expect(schema.validate({ a: "x" })).toEqual([true, null]);
    expect(schema.validate({})).toEqual([false, "missing required key 'a'"]);
  });

  it("schema array items", () => {
    const schema = new SimpleJsonSchema({
      type: "array",
      items: { type: "number" },
    });
    expect(schema.validate([1, 2])).toEqual([true, null]);
    expect(schema.validate([1, "x"])).toEqual([false, "[1]: expected number"]);
  });
  it("schema rejects non-finite numbers and non-integers", () => {
    const numberSchema = new SimpleJsonSchema({ type: "number" });
    const integerSchema = new SimpleJsonSchema({ type: "integer" });
    expect(numberSchema.validate(Number.NaN)).toEqual([false, "expected number"]);
    expect(numberSchema.validate(Number.POSITIVE_INFINITY)).toEqual([false, "expected number"]);
    expect(integerSchema.validate(1.5)).toEqual([false, "expected integer"]);
    expect(integerSchema.validate(2)).toEqual([true, null]);
  });

  it("parse runner json fenced", () => {
    expect(parseRunnerJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseRunnerJson('prefix {"b": 2} suffix')).toEqual({ b: 2 });
  });

  it("parse runner json invalid", () => {
    expect(() => parseRunnerJson("no json here")).toThrow(WorkflowInputError);
  });
});
