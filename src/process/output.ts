import { StringDecoder } from "node:string_decoder";

/** Captures decoded process output while retaining at most maxChars in memory. */
export class BoundedOutputCollector {
  private readonly decoder = new StringDecoder("utf8");
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
    this.capture(this.decoder.write(chunk));
  }

  /** 结束输入，刷新解码器缓冲的残留字符。 */
  end(): void {
    this.capture(this.decoder.end());
  }

  /** 返回当前保留在内存中的输出文本（最多 maxChars 个字符）。 */
  get text(): string {
    return this.retained;
  }

  /** 返回累计接收到的总字符数（含被截断丢弃的部分）。 */
  get total(): number {
    return this.totalChars;
  }

  /** 累加总字符数，并只保留不超过 maxChars 的前缀部分，其余直接丢弃。 */
  private capture(text: string): void {
    this.totalChars += text.length;
    if (this.retained.length < this.maxChars) {
      this.retained += text.slice(0, this.maxChars - this.retained.length);
    }
  }
}

/** 若总字符数超过上限则截断输出，并追加 "... [truncated, N chars total]" 标记；未超限则原样返回。 */
export function formatTruncatedOutput(output: string, totalChars: number, maxChars: number): string {
  if (totalChars <= maxChars) return output;
  return output.slice(0, maxChars) + `\n... [truncated, ${totalChars} chars total]`;
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
