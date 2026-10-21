import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeDirWithRetries } from "../helpers/fs.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-glob-"));
  await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "");
  await fs.writeFile(path.join(dir, "src", "deep", "b.ts"), "");
  await fs.writeFile(path.join(dir, "README.md"), "");
});

afterEach(async () => {
  await removeDirWithRetries(dir);
});

describe("fnmatch", () => {
  it("matches python-style wildcards (* crosses /)", async () => {
    const { fnmatch } = await import("../../src/tools/glob.js");
    expect(fnmatch("src/a.ts", "*.ts")).toBe(true);
    expect(fnmatch("src/deep/b.ts", "*.ts")).toBe(true);
    expect(fnmatch("src/a.ts", "src/*.ts")).toBe(true);
    expect(fnmatch("README.md", "*.ts")).toBe(false);
    expect(fnmatch("src/a.ts", "src/?.ts")).toBe(true);
    expect(fnmatch("src/a.ts", "src/[ab].ts")).toBe(true);
  });

  it("does not throw on unclosed [", async () => {
    const { fnmatch } = await import("../../src/tools/glob.js");
    expect(() => fnmatch("foo[abc", "foo[abc")).not.toThrow();
    expect(fnmatch("foo[abc", "foo[abc")).toBe(true);
    expect(fnmatch("fooX", "foo[abc")).toBe(false);
  });

  it("does not throw on invalid character-class range and falls back to literal match", async () => {
    const { fnmatch } = await import("../../src/tools/glob.js");
    // 真实回归：always_allow 存的命令含 [a-z0-9\-/]，被当 glob 会编译崩溃
    const cmd = 'node x.mjs "[a-z0-9\\-/]*/"';
    expect(() => fnmatch(cmd, cmd)).not.toThrow();
    expect(fnmatch(cmd, cmd)).toBe(true);
    expect(fnmatch('node x.mjs "[abc]"', cmd)).toBe(false);
  });
});

describe("glob", () => {
  it("finds files by pattern, relative paths sorted", async () => {
    const { glob } = await import("../../src/tools/glob.js");
    const out = await glob(dir, { pattern: "*.ts" });
    expect(out.split("\n")).toEqual([
      path.join("src", "a.ts"),
      path.join("src", "deep", "b.ts"),
    ]);
  });

  it("returns (no matches) when empty", async () => {
    const { glob } = await import("../../src/tools/glob.js");
    await expect(glob(dir, { pattern: "*.xyz" })).resolves.toBe("(no matches)");
  });

  it("caps at 200 results", async () => {
    await Promise.all(
      Array.from({ length: 210 }, (_, index) =>
        fs.writeFile(path.join(dir, `f${String(index).padStart(3, "0")}.log`), ""),
      ),
    );
    const { glob } = await import("../../src/tools/glob.js");
    const out = await glob(dir, { pattern: "*.log" });
    expect(out.split("\n")).toHaveLength(200);
  });
});
