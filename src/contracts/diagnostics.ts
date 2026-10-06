/** 一条诊断：启动/加载阶段发现的一个问题，可聚合上报而非逐条抛错。 */
export interface Diagnostic {
  type: "warning" | "error";
  message: string;
  /** 来源路径或字段名，用于定位与去重；可选。 */
  path?: string;
}

function keyOf(diagnostic: Diagnostic): string {
  return `${diagnostic.type}\u0000${diagnostic.path ?? ""}\u0000${diagnostic.message}`;
}

/**
 * 诊断收集器：加载/解析过程往里 push 问题，最后由 composition root 统一上报。
 * 约定：
 *  - `warning` 不阻断启动，仅提示；
 *  - `error` 阻断启动；
 *  - `list()/errors()/warnings()` 返回去重后的结果（按 type + path + message 归一化，保持首次出现顺序）。
 */
export class Diagnostics {
  private readonly items: Diagnostic[] = [];

  push(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  hasErrors(): boolean {
    return this.items.some((item) => item.type === "error");
  }

  list(): Diagnostic[] {
    const seen = new Set<string>();
    const result: Diagnostic[] = [];
    for (const item of this.items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  errors(): Diagnostic[] {
    return this.list().filter((item) => item.type === "error");
  }

  warnings(): Diagnostic[] {
    return this.list().filter((item) => item.type === "warning");
  }

  get size(): number {
    return this.items.length;
  }
}