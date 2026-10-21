import { describe, expect, it } from "vitest";
import { formatFile, formatTerminal, truncateString, truncateStringFields } from "../src/format.js";

describe("formatTerminal", () => {
  it("渲染时间、级别、模块、消息、字段", () => {
    const line = formatTerminal({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "web-server.http",
      message: "chat request",
      fields: { model: "gpt-4o-mini", tools: 5 },
    });
    expect(line).toContain("[info]");
    expect(line).toContain("[web-server.http]");
    expect(line).toContain("chat request");
    expect(line).toContain("model=gpt-4o-mini");
    expect(line).toContain("tools=5");
  });

  it("时间含毫秒", () => {
    const time = new Date();
    time.setHours(8, 3, 22, 123);
    const line = formatTerminal({
      time,
      level: "info",
      module: "x",
      message: "m",
      fields: {},
    });
    expect(line).toContain("08:03:22.123");
  });

  it("含空白的字段值加引号", () => {
    const line = formatTerminal({
      time: new Date(),
      level: "info",
      module: "x",
      message: "m",
      fields: { path: "a b" },
    });
    expect(line).toContain('path="a b"');
  });
});

describe("formatFile", () => {
  it("渲染单行 JSON", () => {
    const line = formatFile({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "web.app",
      message: "turn",
      fields: {},
    });
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("web.app");
    expect(parsed.msg).toBe("turn");
    expect(parsed.time).toBe("2026-09-18T08:03:22.000Z");
  });
});

it("循环引用字段不抛错", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() =>
    formatTerminal({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "x",
      message: "m",
      fields: { circular },
    }),
  ).not.toThrow();
  expect(() =>
    formatFile({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "x",
      message: "m",
      fields: { circular },
    }),
  ).not.toThrow();
});


describe("truncateString", () => {
  it("短值原样返回", () => {
    expect(truncateString("hello")).toBe("hello");
  });

  it("超长值截断并带标记", () => {
    expect(truncateString("a".repeat(600))).toBe("a".repeat(512) + "…[truncated 88 chars]");
  });
});

describe("truncateStringFields", () => {
  it("只截断字符串值，保留结构与非字符串值", () => {
    const out = truncateStringFields({ cmd: "a".repeat(600), n: 3, ok: true });
    expect(out.cmd).toBe("a".repeat(512) + "…[truncated 88 chars]");
    expect(out.n).toBe(3);
    expect(out.ok).toBe(true);
  });
});

describe("截断落盘与终端格式", () => {
  const entry = {
    time: new Date("2026-09-18T08:03:22.000Z"),
    level: "info" as const,
    module: "x",
    message: "m",
    fields: { cmd: "a".repeat(1000) },
  };

  it("formatTerminal 对长字段渲染文本截断", () => {
    const line = formatTerminal(entry);
    expect(line).toContain("…[truncated 488 chars]");
    expect(line).not.toContain("a".repeat(513));
  });

  it("formatFile 对长字符串字段截断且仍可解析", () => {
    const line = formatFile(entry);
    const parsed = JSON.parse(line);
    expect(parsed.fields.cmd).toBe("a".repeat(512) + "…[truncated 488 chars]");
  });

  it("formatFile 保留非字符串字段类型", () => {
    const line = formatFile({ ...entry, fields: { n: 3, ok: true } });
    const parsed = JSON.parse(line);
    expect(parsed.fields.n).toBe(3);
    expect(parsed.fields.ok).toBe(true);
  });
});
