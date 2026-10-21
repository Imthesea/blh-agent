import fs from "node:fs/promises";
import path from "node:path";

/** Python fnmatch 语义：* 跨目录分隔符；? 匹配单字符；[seq] 字符类。 */
export function fnmatch(name: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\[(!|\^)?[^\]]*\]|\[|\]/g, (match, negation: string | undefined) => {
      // 裸括号（未构成合法字符类）转义为字面量，避免非法正则
      if (match === "[" || match === "]") return `\\${match}`;
      const inner = match.slice(negation ? 2 : 1, -1);
      return `[${negation ? "^" : ""}${inner.replace(/\\/g, "\\\\")}]`;
    });
  let regex: RegExp;
  try {
    regex = new RegExp(`^${source}$`);
  } catch {
    // 字符类 range 倒序等非法 glob 无法编译成正则：降级为字面量精确匹配，避免抛出。
    return name === pattern;
  }
  return regex.test(name);
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

export async function glob(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (typeof args.pattern !== "string") throw new TypeError("pattern must be a string");
  const pattern = args.pattern;
  const matches: string[] = [];
  const root = path.resolve(workdir);
  for await (const fullPath of walk(root)) {
    const relativePath = path.relative(root, fullPath);
    const normalized = relativePath.split(path.sep).join("/");
    if (fnmatch(normalized, pattern)) {
      matches.push(relativePath);
      if (matches.length >= 200) break;
    }
  }
  if (matches.length === 0) return "(no matches)";
  return matches.join("\n");
}
