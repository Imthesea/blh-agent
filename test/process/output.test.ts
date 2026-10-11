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

  it("decodes GBK output from cmd.exe on Chinese Windows", () => {
    const output = new BoundedOutputCollector(100);
    // "你好" 的 GBK 编码：0xC4E3 0xBAC3，跨两块到达。
    output.append(Buffer.from([0xc4, 0xe3]));
    output.append(Buffer.from([0xba, 0xc3]));
    output.end();
    expect(output.text).toBe("你好");
  });

  it("prefers UTF-8 over GBK when output is clean UTF-8", () => {
    const output = new BoundedOutputCollector(100);
    output.append(Buffer.from("中文 ok", "utf8"));
    output.end();
    expect(output.text).toBe("中文 ok");
    expect(output.total).toBe(5);
  });

  it("formats truncation with the original total character count", () => {
    expect(formatTruncatedOutput("abcdef", 6, 3)).toBe("abc\n... [truncated, 6 chars total]");
    expect(formatTruncatedOutput("abc", 3, 3)).toBe("abc");
  });
});
