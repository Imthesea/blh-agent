import * as fs from "node:fs";
import * as path from "node:path";
import { foldEvents, type FoldedTurn } from "./fold.js";
import {
  createUsageAccumulator,
  mergeUsageSummaries,
  type UsageAccumulator,
  type UsageSummary,
} from "./pricing.js";
import { Tracer } from "./tracer.js";
import type { TraceEvent } from "./types.js";

/** 最多缓存几天的 trace（LRU，超出淘汰最久未访问的）。 */
const MAX_DAYS = 8;

const TRACE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** 列出所有 trace 日期文件（倒序，过滤非法文件名）。 */
export function listTraceDates(workdir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(Tracer.tracesDir(workdir));
  } catch {
    return [];
  }
  return names
    .map((n) => TRACE_FILE_RE.exec(n)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort()
    .reverse();
}

function traceFile(workdir: string, date: string): string {
  return path.join(Tracer.tracesDir(workdir), `${date}.jsonl`);
}

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
  /** usage 聚合按天独立增量读，不受 events/turns 的 8 天 LRU 影响。 */
  private readonly usageTails = new Map<string, JsonlTail>();
  private readonly usageDays = new Map<string, UsageAccumulator>();
  private foldCount = 0;

  constructor(private readonly workdir: string) {}

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

  /** 从各 trace 文件的 llm 事件聚合 usage；按天增量读、按天累加。 */
  usage(): UsageSummary {
    const dates = listTraceDates(this.workdir);
    // 剔除已删除日期文件的旧累积，避免幽灵数据残留
    const live = new Set(dates);
    for (const d of [...this.usageTails.keys()]) {
      if (!live.has(d)) {
        this.usageTails.delete(d);
        this.usageDays.delete(d);
      }
    }
    for (const date of dates) {
      this.syncUsageDay(date);
    }
    return mergeUsageSummaries([...this.usageDays.values()].map((a) => a.summary()));
  }

  /** 测试与诊断计数。 */
  stats(): { bytesRead: number; folds: number } {
    let bytesRead = 0;
    for (const t of this.usageTails.values()) bytesRead += t.bytesRead;
    for (const c of this.days.values()) bytesRead += c.tail.bytesRead;
    return { bytesRead, folds: this.foldCount };
  }

  private syncUsageDay(date: string): void {
    let tail = this.usageTails.get(date);
    if (tail === undefined) {
      tail = new JsonlTail(traceFile(this.workdir, date));
      this.usageTails.set(date, tail);
    }
    const { lines, reset } = tail.sync();
    let acc = this.usageDays.get(date);
    if (reset || acc === undefined) {
      // 文件被截断/重建：该天累积作废，从头重算
      acc = createUsageAccumulator();
      this.usageDays.set(date, acc);
    }
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as TraceEvent;
        if (e.type !== "llm" || e.status === "error") continue;
        const u = e.usage as { promptTokens?: number; completionTokens?: number } | null | undefined;
        if (u === null || u === undefined) continue;
        acc.add({
          ts: e.ts,
          provider: typeof e.provider === "string" ? e.provider : "",
          model: typeof e.model === "string" ? e.model : "",
          in: u.promptTokens ?? 0,
          out: u.completionTokens ?? 0,
        });
      } catch {
        // 坏行跳过
      }
    }
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
      tail: new JsonlTail(traceFile(this.workdir, date)),
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
