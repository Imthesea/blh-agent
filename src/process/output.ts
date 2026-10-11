import { StringDecoder } from "node:string_decoder";
import { sanitizeSurrogates } from "../contracts/sanitize-unicode.js";
import { truncateChars } from "../contracts/truncate.js";

/** UTF-8 单字符最多 4 字节，按这个上限预留缓冲，避免多字节字符被拦腰截断。 */
const MAX_UTF8_CHAR_BYTES = 4;

/** 统计文本里的替换字符（U+FFFD）数量，用于判断编码是否匹配。 */
function countReplacementChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count;
}

/**
 * 解码子进程输出：优先按 UTF-8；若出现替换字符，再按 GBK 解码，
 * 取「替换字符更少」的结果。用于兼容中文 Windows 上 cmd.exe 按 GBK 输出的情况。
 */
function decodeOutput(buffer: Buffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const utf8Bad = countReplacementChars(utf8);
  if (utf8Bad === 0) return utf8;
  try {
    const gbk = new TextDecoder("gbk").decode(buffer);
    return countReplacementChars(gbk) < utf8Bad ? gbk : utf8;
  } catch {
    // 运行环境不支持 gbk 解码时，退回 UTF-8 结果。
    return utf8;
  }
}

/** Captures decoded process output while retaining at most maxChars in memory. */
export class BoundedOutputCollector {
  private readonly counter = new StringDecoder("utf8");
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private retained = "";
  private totalChars = 0;

  /** 构造收集器，校验 maxChars 必须为非负整数，否则抛出 RangeError。 */
  constructor(readonly maxChars: number) {
    if (!Number.isInteger(maxChars) || maxChars < 0) {
      throw new RangeError("maxChars must be a non-negative integer");
    }
  }

  /** 解码一块 Buffer 输出并追加到保留缓冲区。 */
  append(chunk: Buffer): void {
    // 用 UTF-8 增量解码统计总字符数（不保留文本），保证 UTF-8 输出的计数精确。
    this.totalChars += this.counter.write(chunk).length;
    // 原始字节按上限缓冲，留给 end() 做编码识别与最终文本。
    const cap = this.maxChars * MAX_UTF8_CHAR_BYTES;
    const remaining = cap - this.bufferedBytes;
    if (remaining <= 0) return;
    const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.chunks.push(kept);
    this.bufferedBytes += kept.length;
  }

  /** 结束输入，确定编码并解码出最终文本。 */
  end(): void {
    this.totalChars += this.counter.end().length;
    const text = sanitizeSurrogates(decodeOutput(Buffer.concat(this.chunks)));
    this.chunks.length = 0;
    this.retained = truncateChars(text, this.maxChars);
  }

  /** 返回当前保留在内存中的输出文本（最多 maxChars 个字符）。 */
  get text(): string {
    return this.retained;
  }

  /** 返回累计接收到的总字符数（含被截断丢弃的部分）。 */
  get total(): number {
    return this.totalChars;
  }
}

/** 若总字符数超过上限则截断输出，并追加 "... [truncated, N chars total]" 标记；未超限则原样返回。 */
export function formatTruncatedOutput(output: string, totalChars: number, maxChars: number): string {
  if (totalChars <= maxChars) return output;
  return truncateChars(output, maxChars) + `\n... [truncated, ${totalChars} chars total]`;
}

/**
 * 校验超时秒数必须为 [1, maxSeconds] 区间内的正整数，否则抛出 TypeError。
 * maxSeconds 由 32 位有符号整数上限（2^31-1）减去 50 的安全余量后换算成秒得到，
 * 目的是避免后续把秒转成毫秒时发生整数溢出。
 */
export function validateTimeoutSeconds(timeout: unknown, label = "timeout"): number {
  const maxSeconds = Math.floor((2_147_483_647 - 50) / 1000);
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > maxSeconds
  ) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maxSeconds}`);
  }
  return timeout;
}
