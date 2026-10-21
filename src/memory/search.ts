import type { MemoryRecord, MemoryStore } from "./store.js";

/** 单条结果正文的最大字符数，避免把整段长记忆塞进上下文。 */
const BODY_CHAR_LIMIT = 2000;

/**
 * 按关键词/短语在记忆目录里做 grep 式检索（搜 name + description + body）。
 * 纯函数、不调用模型；供 memory_search 工具按需读取记忆。
 */
export function searchMemory(store: MemoryStore, keyword: string, maxResults = 5): string {
  const query = keyword.trim();
  if (!query) return "(no keyword)";
  const raw = query.toLowerCase();
  // 与 keywordMemorySelection 一致的分词：英文/数字至少 3 位，中文至少 2 字。
  const terms = raw.match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [raw];

  const scored: Array<{ record: MemoryRecord; score: number }> = [];
  for (const record of store.listMemoryFiles()) {
    const haystack = `${record.name}\n${record.description}\n${record.body}`.toLowerCase();
    let score = haystack.includes(raw) ? 2 : 0; // 整段短语命中给更高权重
    for (const term of terms) {
      if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ record, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || (a.record.filename < b.record.filename ? -1 : 1),
  );

  const top = scored.slice(0, Math.max(0, maxResults));
  if (top.length === 0) return "(no matching memory)";
  return top
    .map(({ record }) => {
      const body =
        record.body.length > BODY_CHAR_LIMIT
          ? record.body.slice(0, BODY_CHAR_LIMIT) + "…[truncated]"
          : record.body;
      return `## ${record.filename}\nname: ${record.name}\ndescription: ${record.description}\n\n${body}`;
    })
    .join("\n\n");
}
