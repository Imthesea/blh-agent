import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendDailyLog, localDay } from "../../src/session/daily-log.js";
import type { ChatMessage } from "../../src/contracts/types.js";

describe("daily-log", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dailylog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("追加到 chat/<day>.md 且跳过 system 与 isInternal", () => {
    const now = new Date(2026, 9, 21, 10, 0, 0);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", isInternal: true },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    const file = appendDailyLog(dir, messages, now);
    expect(file).toBe(path.join(dir, "chat", "2026-10-21.md"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("### user");
    expect(text).toContain("hi");
    expect(text).toContain("### tool [c1]");
    expect(text).not.toContain("sys");
    expect(text).not.toContain("hello");
  });

  it("同一天多次运行是追加", () => {
    const now = new Date(2026, 9, 21, 10, 0, 0);
    appendDailyLog(dir, [{ role: "user", content: "one" }], now);
    appendDailyLog(dir, [{ role: "user", content: "two" }], now);
    const text = readFileSync(path.join(dir, "chat", "2026-10-21.md"), "utf8");
    expect(text).toContain("one");
    expect(text).toContain("two");
  });

  it("localDay 返回本地日期", () => {
    expect(localDay(new Date(2026, 9, 21))).toBe("2026-10-21");
  });
});