import type { ToolRegistry } from "../tools/registry.js";
import { searchMemory } from "./search.js";
import type { MemoryStore } from "./store.js";

/** 注册记忆相关工具：让模型在回合内按需 grep 记忆目录（而非每轮预注入）。 */
export function registerMemoryTools(registry: ToolRegistry, store: MemoryStore): void {
  registry.register({
    name: "memory_search",
    description:
      "Search long-term memory (.memory/) for records matching a keyword or phrase. " +
      "Use before answering questions about the user's preferences, facts, or history.",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword or phrase to search for" },
        max_results: { type: "number", description: "Max records to return (default 5)" },
      },
      required: ["keyword"],
    },
    handler: async (args) => {
      const keyword = typeof args.keyword === "string" ? args.keyword : "";
      const max =
        typeof args.max_results === "number" && Number.isInteger(args.max_results) && args.max_results > 0
          ? args.max_results
          : 5;
      return searchMemory(store, keyword, max);
    },
  });
}
