import { describe, expect, it } from "vitest";
import {
  BoundedOutputCollector,
  formatTruncatedOutput,
} from "../../src/process/output.js";

describe("process output", () => {
  it("retains only the configured number of characters", () => {
    const output = new BoundedOutputCollector(3);
    output.append(Buffer.from("abcdef"));
    output.end();
    expect(output.text).toBe("abc");
    expect(output.total).toBe(6);
  });

  it("handles UTF-8 sequences split across chunks", () => {
    const output = new BoundedOutputCollector(10);
    output.append(Buffer.from([0xe4, 0xb8]));
    output.append(Buffer.from([0xad]));
    output.end();
    expect(output.text).toBe("中");
    expect(output.total).toBe(1);
  });

  it("formats truncation with the original total character count", () => {
    expect(formatTruncatedOutput("abcdef", 6, 3)).toBe("abc\n... [truncated, 6 chars total]");
    expect(formatTruncatedOutput("abc", 3, 3)).toBe("abc");
  });
});
