import { describe, it, expect, afterEach } from "vitest";
import { readEnv } from "../../src/core/env.js";

const KEY = "BLH_TEST_READ_ENV";

describe("readEnv", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("返回非空环境变量的值", () => {
    process.env[KEY] = "hello";
    expect(readEnv(KEY)).toBe("hello");
  });

  it("未设置时返回 undefined", () => {
    delete process.env[KEY];
    expect(readEnv(KEY)).toBeUndefined();
  });

  it("空字符串视为未设置", () => {
    process.env[KEY] = "";
    expect(readEnv(KEY)).toBeUndefined();
  });
});
