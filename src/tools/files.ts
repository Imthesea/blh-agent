import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { resolveToCwd } from "./path-utils.js";

export class PathEscapeError extends Error {}

/** 单次 read_file 允许读取的最大字节数，超过则报错而非整读，避免大文件撑爆上下文。 */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/**
 * 解析文件工具路径：先做 ~ 展开、Unicode 空格归一化、file:// / Windows shell 路径转换。
 * sandboxRoot 为 undefined（full 模式）时不做边界校验；给定 sandboxRoot（workspace 模式）时
 * 校验解析结果必须落在 sandboxRoot 内，否则抛 PathEscapeError。
 */
export function safePath(workdir: string, inputPath: string, sandboxRoot?: string): string {
  const resolved = resolveToCwd(inputPath, workdir);
  if (sandboxRoot === undefined) return resolved;
  const root = path.resolve(sandboxRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(`path escapes sandbox root: ${inputPath}`);
  }
  return resolved;
}

/** workspace 模式下用真实路径（realpath）二次校验，防止 sandboxRoot 内的 symlink 指向外部被跟随读写。 */
async function assertInside(sandboxRoot: string, realPath: string): Promise<void> {
  const realRoot = await fs.realpath(sandboxRoot);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new PathEscapeError(`path escapes sandbox root: ${realPath}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
  return value;
}

export async function readFile(
  workdir: string,
  args: Record<string, unknown>,
  sandboxRoot?: string,
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"), sandboxRoot);
  const start = optionalNumber(args.start, "start", 0);
  const limit = optionalNumber(args.limit, "limit", 2000);
  if (sandboxRoot !== undefined) await assertInside(sandboxRoot, await fs.realpath(filePath));
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_READ_BYTES) {
    return `error: file exceeds max read size (${MAX_READ_BYTES} bytes)`;
  }
  const text = await fs.readFile(filePath, "utf8");
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const slice = lines.slice(start, start + limit);
  if (slice.length === 0) return "(no more lines)";
  return slice.map((line, i) => `${i + start + 1}\t${line}`).join("\n");
}

export async function writeFile(
  workdir: string,
  args: Record<string, unknown>,
  sandboxRoot?: string,
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"), sandboxRoot);
  const content = requireString(args.content, "content");
  const parentPath = path.dirname(filePath);
  if (sandboxRoot !== undefined) await assertMissingPathInside(sandboxRoot, parentPath);
  await fs.mkdir(parentPath, { recursive: true });
  if (sandboxRoot !== undefined) {
    await assertInside(sandboxRoot, await fs.realpath(parentPath));
    try {
      await assertInside(sandboxRoot, await fs.realpath(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow;
  const handle = await fs.open(filePath, flags);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return `wrote ${content.length} chars to ${filePath}`;
}

async function assertMissingPathInside(sandboxRoot: string, inputPath: string): Promise<void> {
  let current = inputPath;
  for (;;) {
    try {
      await assertInside(sandboxRoot, await fs.realpath(current));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function editFile(
  workdir: string,
  args: Record<string, unknown>,
  sandboxRoot?: string,
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"), sandboxRoot);
  const oldText = requireString(args.old_text, "old_text");
  const newText = requireString(args.new_text, "new_text");
  if (sandboxRoot !== undefined) await assertInside(sandboxRoot, await fs.realpath(filePath));
  const text = await fs.readFile(filePath, "utf8");
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    return `error: old_text occurs ${count} times (must be exactly 1)`;
  }
  await fs.writeFile(filePath, text.replace(oldText, newText), "utf8");
  return `edited ${filePath}`;
}
