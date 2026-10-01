import * as fs from "node:fs";
import * as path from "node:path";
import { foldEvents, type FoldedTurn } from "./fold.js";
import { createUsageAccumulator, type UsageAccumulator, type UsageSummary } from "./pricing.js";
import { Tracer } from "./tracer.js";
import type { TraceEvent, UsageRecord } from "./types.js";

/** 最多缓存几天的 trace（LRU，超出淘汰最久未访问的）。 */
const MAX_DAYS = 8;

/**
 * 单文件增量读取（tail -f 模式）：记住读到的字节偏移，每次 sync 只读新增部分。
 * 末尾不完整行（半行）暂存 pending，下次拼接；文件截断或删除重建时重置。
 * 成本只与新增量挂钩，与文件总量无关。
 */
export class JsonlTail {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  /** 累计读取字节数（测试与诊断用）。 */
  bytesRead = 0;

  constructor(private readonly file: string) {}

  /**
   * 读取新增完整行（不含空行）。
   * reset=true 表示文件被截断/删除重建，调用方应丢弃已累积的状态。
   */
  sync(): { lines: string[]; reset: boolean } {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      // 文件不存在：清空状态，等重建后从头读
      if (this.offset !== 0 || this.pending.length !== 0) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        return { lines: [], reset: true };
      }
      return { lines: [], reset: false };
    }
    let reset = false;
    if (size < this.offset) {
      // 文件变小了：被截断或重建，从头读
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      reset = true;
    }
    if (size === this.offset) return { lines: [], reset };

    const len = size - this.offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, "r");
    let n: number;
    try {
      n = fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += n;
    this.bytesRead += n;

    // pending 用 Buffer 拼接，多字节字符被切断时不会损坏
    const data = Buffer.concat([this.pending, buf.subarray(0, n)]);
    const lastNl = data.lastIndexOf(0x0a); // "\n"
    if (lastNl === -1) {
      this.pending = data;
      return { lines: [], reset };
    }
    this.pending = data.subarray(lastNl + 1);
    const lines = data
      .subarray(0, lastNl)
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    return { lines, reset };
  }
}

interface DayCache {
  tail: JsonlTail;
  /** 已解析事件；坏行存 null 占位，保持 cursor = 非空行索引的语义。 */
  parsed: (TraceEvent | null)[];
  /** fold 缓存；有新行或文件重置时置 null（脏标记）。 */
  turns: FoldedTurn[] | null;
}

/**
 * Trace 数据读取层：文件仍是唯一数据源，但每个文件只增量读新增字节，
 * 解析结果与 fold 结果随缓存复用。多次调用成本稳定，不随文件增长膨胀。
 */
export class TraceStore {
  private readonly days = new Map<string, DayCache>();
  private readonly usageTail: JsonlTail;
  private usageAcc: UsageAccumulator;
  private foldCount = 0;

  constructor(private readonly workdir: string) {
    this.usageTail = new JsonlTail(path.join(workdir, ".blh", "usage.jsonl"));
    this.usageAcc = createUsageAccumulator();
  }

  /** cursor = 非空行索引（坏行占位计入）；越界返回空 + 当前 total。 */
  events(date: string, cursor: number): { events: TraceEvent[]; nextCursor: number } {
    const c = this.syncDay(date);
    const total = c.parsed.length;
    if (cursor >= total) return { events: [], nextCursor: total };
    const events: TraceEvent[] = [];
    for (let i = Math.max(0, cursor); i < total; i++) {
      const e = c.parsed[i]!;
      if (e !== null) events.push(e);
    }
    return { events, nextCursor: total };
  }

  /** 折叠 turn 视图；无新增时命中缓存，不重复 fold。 */
  turns(date: string): FoldedTurn[] {
    const c = this.syncDay(date);
    if (c.turns === null) {
      this.foldCount++;
      c.turns = foldEvents(c.parsed.filter((e): e is TraceEvent => e !== null));
    }
    return c.turns;
  }

  /** usage.jsonl 增量聚合；每条记录只累加一次。 */
  usage(): UsageSummary {
    const { lines, reset } = this.usageTail.sync();
    if (reset) {
      // 文件被截断/重建：已累加值作废，随从头读重新累加
      this.usageAcc = createUsageAccumulator();
    }
    for (const line of lines) {
      try {
        this.usageAcc.add(JSON.parse(line) as UsageRecord);
      } catch {
        // 坏行跳过
      }
    }
    return this.usageAcc.summary();
  }

  /** 测试与诊断计数。 */
  stats(): { bytesRead: number; folds: number } {
    let bytesRead = this.usageTail.bytesRead;
    for (const c of this.days.values()) bytesRead += c.tail.bytesRead;
    return { bytesRead, folds: this.foldCount };
  }

  private syncDay(date: string): DayCache {
    const c = this.day(date);
    const { lines, reset } = c.tail.sync();
    if (reset) {
      c.parsed = [];
      c.turns = null;
    }
    if (lines.length > 0) {
      for (const line of lines) {
        try {
          c.parsed.push(JSON.parse(line) as TraceEvent);
        } catch {
          c.parsed.push(null); // 坏行占位
        }
      }
      c.turns = null; // 脏标记
    }
    return c;
  }

  private day(date: string): DayCache {
    const existing = this.days.get(date);
    if (existing !== undefined) {
      // 触碰：移到最新位置（Map 迭代序 = 插入序）
      this.days.delete(date);
      this.days.set(date, existing);
      return existing;
    }
    const cache: DayCache = {
      tail: new JsonlTail(path.join(Tracer.tracesDir(this.workdir), `${date}.jsonl`)),
      parsed: [],
      turns: null,
    };
    this.days.set(date, cache);
    if (this.days.size > MAX_DAYS) {
      const oldest = this.days.keys().next().value!;
      this.days.delete(oldest);
    }
    return cache;
  }
}
