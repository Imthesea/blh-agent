import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const TEMPORARY_MEMORY_MARKERS = [
  "this session", "current session", "this turn", "current turn",
  "this task", "current task", "for now", "just this time", "today only",
  "本次会话", "当前会话", "这一轮", "当前轮次", "本次任务", "当前任务",
  "暂时", "今回だけ", "このセッション", "現在のタスク",
] as const;

export const INDEX_NAME = "MEMORY.md";

export class MemoryStore {
  readonly directory: string;
  readonly indexPath: string;

  /**
   * 构造函数：创建一个记忆存储实例。
   * @param directory 记忆文件的存放目录（绝对或相对路径均可，内部会统一处理）。
   *  - this.directory：保存目录路径。
   *  - this.indexPath：索引文件（MEMORY.md）的完整路径，等于 directory 与 INDEX_NAME 拼接的结果。
   */
  constructor(directory: string) {
    this.directory = directory;
    this.indexPath = path.join(this.directory, INDEX_NAME);
  }

  /**
   * 解析 Markdown 文件开头的 YAML frontmatter（即被 --- 包裹的元数据区块）。
   * @param text 完整的 Markdown 文本内容。
   * @returns 返回一个二元组：
   *  - 第一个元素：解析出的元数据对象（键值对）。
   *  - 第二个元素：去掉 frontmatter 后的正文内容。
   *
   * 解析规则：
   *  1. 如果文本不是以 "---\n" 开头，说明没有 frontmatter，直接返回 [空对象, 原文]。
   *  2. 按 "---" 分割文本，若分段少于 3 段，说明 frontmatter 不完整，返回 [空对象, 原文]。
   *  3. 中间段（parts[1]）作为 YAML 解析；解析失败也返回 [空对象, 原文]。
   *  4. 校验解析结果必须是普通对象（不能是 null、数组），否则返回 [空对象, 原文]。
   *  5. 成功时返回 [元数据, 剩余部分（去掉开头的换行/空白）]。
   */
  static parseFrontmatter(text: string): [Record<string, unknown>, string] {
    if (!text.startsWith("---\n")) {
      return [{}, text];
    }
    const parts = text.split("---");
    if (parts.length < 3) {
      return [{}, text];
    }
    let metadata: unknown;
    try {
      metadata = parseYaml(parts[1] ?? "") || {};
    } catch {
      return [{}, text];
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      return [{}, text];
    }
    return [metadata as Record<string, unknown>, parts.slice(2).join("---").trimStart()];
  }

  /**
   * 将记忆名称转换为可用于文件名的 slug（短横线分隔的标识符）。
   * @param name 原始名称，例如 "My Important Note" 或 "用户配置"。
   * @returns 转换后的 slug 字符串；如果转换结果为空，则返回兜底值 "memory"。
   *
   * 转换规则：
   *  1. 全部转为小写。
   *  2. 把连续的「非字母、非数字、非下划线」字符（支持 Unicode 字母/数字）替换为单个短横线 "-"。
   *  3. 去掉开头和结尾的短横线或下划线。
   *  4. 若最终为空字符串，返回 "memory" 作为默认名。
   */
  static memorySlug(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, "-")
      .replace(/^[-_]+|[-_]+$/g, "");
    return slug || "memory";
  }

  /**
   * 将给定的文件名解析为存储目录内的绝对路径，并进行安全性校验，防止路径逃逸。
   * @param filename 文件名（仅允许纯文件名，不允许包含目录分隔符）。
   * @param allowIndex 是否允许访问索引文件 MEMORY.md（默认 false，即索引文件不视为普通记忆记录）。
   * @returns 存储目录内该文件的绝对路径。
   *
   * 校验规则：
   *  1. 如果 filename 不是纯文件名（例如包含 "/" 或 "\"），抛出异常。
   *  2. 如果 filename 是索引文件名且未显式允许，抛出异常。
   *  3. 计算相对路径，若结果为空、以 ".." 开头或为绝对路径，说明逃逸出了存储目录，抛出异常。
   *  4. 全部通过后返回解析后的绝对路径。
   */
  memoryPath(filename: string, allowIndex = false): string {
    if (path.basename(filename) !== filename) {
      throw new Error(`Invalid memory filename: ${filename}`);
    }
    if (filename === INDEX_NAME && !allowIndex) {
      throw new Error("The memory index is not a memory record");
    }
    const candidate = path.resolve(this.directory, filename);
    const relative = path.relative(path.resolve(this.directory), candidate);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Memory path escapes the store: ${filename}`);
    }
    return candidate;
  }

  /**
   * 对文本做标准化处理，用于后续去重比较。
   * @param value 原始文本。
   * @returns 标准化后的字符串：转为小写、按空白字符切分、过滤空串、用单个空格重新拼接。
   *  - 这样可以让「大小写不同」「多个空格/换行」等在比较时被视为等价。
   */
  private static normalized(value: string): string {
    return value.toLowerCase().split(/\s+/).filter((part) => part !== "").join(" ");
  }

  /**
   * 判断一条候选记忆是否值得写入存储。
   * @param candidate 候选记忆对象，需包含 scope、type、name、description、body 等字段。
   * @param existing 已存在的记忆对象数组，用于去重比较。
   * @returns 返回 true 表示应当存储，false 表示应当跳过。
   *
   * 判定规则（按顺序，任一不满足即返回 false）：
   *  1. scope 必须等于 "persistent"（只存储持久化记忆，临时记忆不落盘）。
   *  2. type 必须是 MEMORY_TYPES 中允许的类型之一。
   *  3. name、description、body 三者均不能为空。
   *  4. name + description + body 的合并文本不能包含任何「临时会话」标记词（例如 "本次会话"、"this session"）。
   *  5. 去重：与已有记忆逐一比较——
   *     - name 生成的 slug 相同 → 跳过；
   *     - description 标准化后相同 → 跳过；
   *     - body 标准化后相同 → 跳过。
   *  全部通过才返回 true。
   */
  shouldStoreMemory(candidate: Record<string, unknown>, existing: Record<string, unknown>[]): boolean {
    if (candidate.scope !== "persistent") {
      return false;
    }
    if (typeof candidate.type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(candidate.type)) {
      return false;
    }

    const name = String(candidate.name ?? "").trim();
    const description = String(candidate.description ?? "").trim();
    const body = String(candidate.body ?? "").trim();
    if (!name || !description || !body) {
      return false;
    }

    const candidateText = MemoryStore.normalized(`${name}\n${description}\n${body}`);
    if (TEMPORARY_MEMORY_MARKERS.some((marker) => candidateText.includes(marker))) {
      return false;
    }

    const slug = MemoryStore.memorySlug(name);
    const normalizedDescription = MemoryStore.normalized(description);
    const normalizedBody = MemoryStore.normalized(body);
    for (const memory of existing) {
      if (MemoryStore.memorySlug(String(memory.name ?? "")) === slug) {
        return false;
      }
      if (MemoryStore.normalized(String(memory.description ?? "")) === normalizedDescription) {
        return false;
      }
      if (MemoryStore.normalized(String(memory.body ?? "")) === normalizedBody) {
        return false;
      }
    }
    return true;
  }

  /**
   * 生成一条记忆记录对应的 Markdown 文档内容（frontmatter + 正文）。
   * @param name 记忆名称。
   * @param memType 记忆类型（如 "user"、"project" 等）。
   * @param description 记忆描述。
   * @param body 记忆正文内容。
   * @returns 完整的 Markdown 文本：
   *  - 第一段是 YAML frontmatter，包含 name、description、type 三个字段；
   *  - 之后是一个空行 + 正文（去除首尾空白） + 末尾换行。
   */
  memoryDocument(name: string, memType: string, description: string, body: string): string {
    const metadata = stringifyYaml(
      { name, description, type: memType },
      { sortMapEntries: false },
    ).trim();
    return `---\n${metadata}\n---\n\n${body.trim()}\n`;
  }

  /**
   * 将一条记忆写入磁盘文件，并重建索引。
   * @param name 记忆名称（不能为空）。
   * @param memType 记忆类型（必须是 MEMORY_TYPES 之一）。
   * @param description 记忆描述（不能为空）。
   * @param body 记忆正文（不能为空）。
   * @returns 写入的文件绝对路径。
   *
   * 流程：
   *  1. 校验 name、memType、description、body 的合法性（非法则抛出异常）。
   *  2. 确保存储目录存在（递归创建）。
   *  3. 以 name 生成的 slug + ".md" 作为文件名，写入 memoryDocument 生成的 Markdown 内容。
   *  4. 调用 rebuildMemoryIndex 重建索引。
   *  5. 返回文件绝对路径。
   */
  writeMemoryFile(name: string, memType: string, description: string, body: string): string {
    if (!name.trim()) {
      throw new Error("Memory name cannot be empty");
    }
    if (!(MEMORY_TYPES as readonly string[]).includes(memType)) {
      throw new Error(`Unknown memory type: ${memType}`);
    }
    if (!description.trim() || !body.trim()) {
      throw new Error("Memory description and body cannot be empty");
    }
    mkdirSync(this.directory, { recursive: true });
    const filePath = this.memoryPath(`${MemoryStore.memorySlug(name)}.md`);
    writeFileSync(filePath, this.memoryDocument(name, memType, description, body), "utf-8");
    this.rebuildMemoryIndex();
    return filePath;
  }

  /**
   * 重建索引文件 MEMORY.md：扫描存储目录下的所有 .md 记忆文件，生成索引条目列表。
   * 无参数、无返回值。
   *
   * 流程：
   *  1. 确保存储目录存在。
   *  2. 遍历目录下所有 .md 文件（按文件名排序），跳过索引文件本身。
   *  3. 对每个文件：
   *     - 解析 frontmatter，得到元数据和正文；
   *     - 取 name（缺省用文件名去掉 .md 后缀），并把空白字符压缩成单个空格；
   *     - 取 description（缺省用正文第一行非空内容），同样压缩空白；
   *     - 生成一行 "- [名称](文件名) - 描述" 的索引条目。
   *  4. 把所有条目拼接写入 MEMORY.md；若没有任何条目，则写入空文件。
   */
  rebuildMemoryIndex(): void {
    mkdirSync(this.directory, { recursive: true });
    const lines: string[] = [];
    for (const fileName of readdirSync(this.directory).filter((f) => f.endsWith(".md")).sort()) {
      if (fileName === INDEX_NAME) {
        continue;
      }
      let filePath: string;
      try {
        filePath = this.memoryPath(fileName);
      } catch {
        continue;
      }
      const [metadata, body] = MemoryStore.parseFrontmatter(readFileSync(filePath, "utf-8"));
      const name = String(metadata.name || path.basename(fileName, ".md"))
        .split(/\s+/).filter((part) => part !== "").join(" ");
      const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
      const description = String(metadata.description || firstLine)
        .split(/\s+/).filter((part) => part !== "").join(" ");
      lines.push(`- [${name}](${fileName}) - ${description}`);
    }
    writeFileSync(
      this.memoryPath(INDEX_NAME, true),
      lines.join("\n") + (lines.length ? "\n" : ""),
      "utf-8",
    );
  }

  /**
   * 读取索引文件 MEMORY.md 的文本内容。
   * @returns 索引文件的完整文本（去掉首尾空白）；如果路径非法或文件不存在，返回空字符串 ""。
   */
  readMemoryIndex(): string {
    let filePath: string;
    try {
      filePath = this.memoryPath(INDEX_NAME, true);
    } catch {
      return "";
    }
    return existsSync(filePath) ? readFileSync(filePath, "utf-8").trim() : "";
  }

  /**
   * 读取单个记忆文件的完整文本内容。
   * @param filename 记忆文件名。
   * @returns 文件内容字符串；如果文件名非法或文件读取失败（如不存在），返回 null。
   */
  readMemoryFile(filename: string): string | null {
    let filePath: string;
    try {
      filePath = this.memoryPath(filename);
    } catch {
      return null;
    }
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 列出存储目录下所有记忆记录。
   * @returns MemoryRecord 数组（按文件名排序）；如果目录不存在，返回空数组。
   *
   * 每条记录字段说明：
   *  - filename：文件名；
   *  - name：记忆名称（缺省用文件名去掉 .md 后缀）；
   *  - description：描述（缺省为空字符串）；
   *  - type：类型（缺省为 "project"）；
   *  - body：去除首尾空白后的正文内容。
   */
  listMemoryFiles(): MemoryRecord[] {
    const records: MemoryRecord[] = [];
    if (!existsSync(this.directory)) {
      return records;
    }
    for (const fileName of readdirSync(this.directory).filter((f) => f.endsWith(".md")).sort()) {
      if (fileName === INDEX_NAME) {
        continue;
      }
      let filePath: string;
      try {
        filePath = this.memoryPath(fileName);
      } catch {
        continue;
      }
      const [metadata, body] = MemoryStore.parseFrontmatter(readFileSync(filePath, "utf-8"));
      records.push({
        filename: fileName,
        name: String(metadata.name || path.basename(fileName, ".md")),
        description: String(metadata.description || ""),
        type: String(metadata.type || "project"),
        body: body.trim(),
      });
    }
    return records;
  }
}

export type MemoryRecord = {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
};
