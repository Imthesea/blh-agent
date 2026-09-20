// src/memory/system.ts
import type { ChatMessage, ChatProvider } from "../core/types.js";
import { MemoryExtractor } from "./extract.js";
import { MemoryRecall } from "./recall.js";
import { MemoryStore } from "./store.js";

export class Memory {
  /** 读记忆（召回）：从存储里读出与当前对话相关的记忆，用于辅助回答。 */
  readonly recall: MemoryRecall;
  /** 写记忆（提取）：从当前对话里提炼出值得长期保存的信息，写入存储。 */
  readonly extractor: MemoryExtractor;

  /**
   * 构造函数：创建一个记忆系统实例。
   * @param store 记忆存储实例（负责记忆文件与索引的读写）。
   * @param provider 聊天模型提供者（用于召回、提取、合并时调用模型）。
   *  - this.store / this.provider：保存传入的存储与模型提供者。
   *  - this.recall：基于 store 和 provider 构建的记忆召回组件（读记忆）。
   *  - this.extractor：基于 store 和 provider 构建的记忆提取组件（写记忆）。
   */
  constructor(
    readonly store: MemoryStore,
    readonly provider: ChatProvider,
  ) {
    this.recall = new MemoryRecall(store, provider);
    this.extractor = new MemoryExtractor(store, provider);
  }

  /**
   * 生成记忆相关的系统提示片段，用于注入到后续对话的上下文里。
   * @param messages 当前对话消息列表。
   * @returns 组装好的系统提示字符串：
   *  - 先调用召回组件加载与当前消息相关的记忆记录；
   *  - 再由召回组件把这些记忆与索引（MEMORY.md）组装成完整文本。
   *  若没有任何相关记忆，返回空字符串。
   */
  async systemSection(messages: ChatMessage[]): Promise<string> {
    const relevant = await this.recall.loadMemories(messages);
    return this.recall.buildSystem(relevant);
  }

  /**
   * 从当前对话中提取持久记忆并写入存储。
   * @param messages 当前对话消息列表。
   * @returns 本次成功写入的记忆条数（未提取到或提取失败时返回 0）。
   */
  async extract(messages: ChatMessage[]): Promise<number> {
    return this.extractor.extractMemories(messages);
  }

  /**
   * 合并整理已有的记忆记录（去重、纠错、删除无用信息）。
   * @returns 合并后的记忆条数；记录数量不足或合并失败时返回 0。
   */
  async consolidate(): Promise<number> {
    return this.extractor.consolidateMemories();
  }
}
