import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export class PathEscapeError extends Error {}

/** 单次 read_file 允许读取的最大字节数，超过则报错而非整读，避免大文件撑爆上下文。 */
const MAX_READ_BYTES = 10 * 1024 * 1024;

export function safePath(workdir: string, inputPath: string): string {
  const resolved = path.resolve(workdir, inputPath);
  const root = path.resolve(workdir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(`path escapes workdir: ${inputPath}`);
  }
  return resolved;
}

/** 用真实路径（realpath）二次校验，防止 workdir 内的 symlink 指向外部目录被跟随读写。 */
async function assertInside(workdir: string, realPath: string): Promise<void> {
  const realRoot = await fs.realpath(workdir);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new PathEscapeError(`path escapes workdir: ${realPath}`);
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
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"));
  const start = optionalNumber(args.start, "start", 0);
  const limit = optionalNumber(args.limit, "limit", 2000);
  await assertInside(workdir, await fs.realpath(filePath));
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
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"));
  const content = requireString(args.content, "content");
  const parentPath = path.dirname(filePath);
  await assertMissingPathInside(workdir, parentPath);
  await fs.mkdir(parentPath, { recursive: true });
  await assertInside(workdir, await fs.realpath(parentPath));
  try {
    await assertInside(workdir, await fs.realpath(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

async function assertMissingPathInside(workdir: string, inputPath: string): Promise<void> {
  let current = inputPath;
  for (;;) {
    try {
      await assertInside(workdir, await fs.realpath(current));
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
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"));
  const oldText = requireString(args.old_text, "old_text");
  const newText = requireString(args.new_text, "new_text");
  await assertInside(workdir, await fs.realpath(filePath));
  const text = await fs.readFile(filePath, "utf8");
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    return `error: old_text occurs ${count} times (must be exactly 1)`;
  }
  await fs.writeFile(filePath, text.replace(oldText, newText), "utf8");
  return `edited ${filePath}`;
}
