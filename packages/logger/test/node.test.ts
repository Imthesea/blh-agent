import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRawEntry, createLogger, flushPendingDedup, initLogger, resetLogger, setLogSid } from "../src/node.js";
import { fileDate } from "../src/format.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "logger-"));
  resetLogger();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetLogger();
  vi.restoreAllMocks();
});

describe("node logger", () => {
  it("initLogger 后写文件", async () => {
    initLogger(tmpDir, "info");
    const log = createLogger("providers.openai");
    log.info("chat request", { model: "m" });
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    await vi.waitFor(() => {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("chat request");
    });
  });

  it("未 initLogger 时只写 stderr 不写文件", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("x");
    log.info("hello");
    expect(write).toHaveBeenCalled();
    expect(existsSync(path.join(tmpDir, ".blh", "logs"))).toBe(false);
  });

  it("过滤 debug（默认 info 级别）", async () => {
    initLogger(tmpDir, "info");
    const log = createLogger("x");
    log.debug("hidden");
    log.info("shown");
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    await vi.waitFor(() => {
      const content = readFileSync(file, "utf8");
      expect(content).toContain("shown");
      expect(content).not.toContain("hidden");
    });
  });

  it("child 拼接名字", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("core").child("loop");
    log.info("turn");
    expect(write.mock.calls[0]?.[0]).toContain("[core.loop]");
  });

  it("error 附带消息与堆栈", async () => {
    initLogger(tmpDir, "error");
    const log = createLogger("x");
    log.error("failed", {}, new Error("boom"));
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    await vi.waitFor(() => {
      const content = readFileSync(file, "utf8");
      expect(content).toContain("failed: boom");
      expect(content).toContain("stack");
    });
  });

  it("写文件失败时不抛错", () => {
    initLogger(tmpDir, "info");
    // 把目标日志文件占位成目录，使 appendFile 异步 reject（EISDIR），内部 catch 吞掉
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    mkdirSync(file, { recursive: true });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("x");
    expect(() => log.info("hello")).not.toThrow();
    expect(write).toHaveBeenCalled();
  });

  it("appendRawEntry 过滤低于当前级别的日志", async () => {
    initLogger(tmpDir, "info");
    appendRawEntry({ time: new Date(), level: "debug", module: "x", message: "hidden", fields: {} });
    appendRawEntry({ time: new Date(), level: "info", module: "x", message: "shown", fields: {} });
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    await vi.waitFor(() => {
      const content = readFileSync(file, "utf8");
      expect(content).toContain("shown");
      expect(content).not.toContain("hidden");
    });
  });
});


describe("文件 sink 去重", () => {
  const logFile = (): string => path.join(tmpDir, ".blh", "logs", "blh-" + fileDate(new Date()) + ".log");

  it("同一 error 窗口内只落第一条，flush 后补重复计数", async () => {
    initLogger(tmpDir, "error");
    const log = createLogger("x");
    for (let i = 0; i < 5; i++) log.error("boom", {}, new Error("boom"));
    const file = logFile();
    await vi.waitFor(() => {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("boom: boom");
    });
    flushPendingDedup();
    await vi.waitFor(() => {
      expect(readFileSync(file, "utf8")).toContain("重复 4 次");
    });
  });

  it("不同 fields 不去重", async () => {
    initLogger(tmpDir, "warn");
    const log = createLogger("x");
    log.warn("fail", { n: 1 });
    log.warn("fail", { n: 2 });
    const file = logFile();
    await vi.waitFor(() => {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
    });
  });

  it("info 级别不去重", async () => {
    initLogger(tmpDir, "info");
    const log = createLogger("x");
    log.info("tick");
    log.info("tick");
    const file = logFile();
    await vi.waitFor(() => {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
    });
  });

  it("resetLogger 清空去重状态", async () => {
    initLogger(tmpDir, "error");
    const log = createLogger("x");
    log.error("boom", { n: 1 });
    log.error("boom", { n: 1 });
    resetLogger();
    initLogger(tmpDir, "error");
    createLogger("x").error("boom", { n: 1 });
    const file = logFile();
    await vi.waitFor(() => {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
    });
  });

  it("长字段落盘被截断", async () => {
    initLogger(tmpDir, "info");
    createLogger("x").info("big", { cmd: "a".repeat(1000) });
    const file = logFile();
    await vi.waitFor(() => {
      const content = readFileSync(file, "utf8");
      expect(content).toContain("…[truncated 488 chars]");
      expect(content).not.toContain("a".repeat(513));
    });
  });
});


describe("sid 上下文", () => {
  const logFile = (): string => path.join(tmpDir, ".blh", "logs", "blh-" + fileDate(new Date()) + ".log");

  it("setLogSid 后落盘日志带 sid", async () => {
    initLogger(tmpDir, "info");
    setLogSid("session_x.jsonl");
    createLogger("x").info("hello");
    setLogSid(null);
    const file = logFile();
    await vi.waitFor(() => {
      const line = JSON.parse(readFileSync(file, "utf8").split("\n").filter(Boolean)[0]!);
      expect(line.sid).toBe("session_x.jsonl");
      expect(line.msg).toBe("hello");
    });
  });

  it("resetLogger 清空 sid 上下文", async () => {
    initLogger(tmpDir, "info");
    setLogSid("session_x.jsonl");
    resetLogger();
    initLogger(tmpDir, "info");
    createLogger("x").info("hello");
    const file = logFile();
    await vi.waitFor(() => {
      const line = JSON.parse(readFileSync(file, "utf8").split("\n").filter(Boolean)[0]!);
      expect(line.sid).toBeUndefined();
    });
  });
});
