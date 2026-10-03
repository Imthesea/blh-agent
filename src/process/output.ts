import { StringDecoder } from "node:string_decoder";

/** Captures decoded process output while retaining at most maxChars in memory. */
export class BoundedOutputCollector {
  private readonly decoder = new StringDecoder("utf8");
  private retained = "";
  private totalChars = 0;

  constructor(readonly maxChars: number) {
    if (!Number.isInteger(maxChars) || maxChars < 0) {
      throw new RangeError("maxChars must be a non-negative integer");
    }
  }

  append(chunk: Buffer): void {
    this.capture(this.decoder.write(chunk));
  }

  end(): void {
    this.capture(this.decoder.end());
  }

  get text(): string {
    return this.retained;
  }

  get total(): number {
    return this.totalChars;
  }

  private capture(text: string): void {
    this.totalChars += text.length;
    if (this.retained.length < this.maxChars) {
      this.retained += text.slice(0, this.maxChars - this.retained.length);
    }
  }
}

export function formatTruncatedOutput(output: string, totalChars: number, maxChars: number): string {
  if (totalChars <= maxChars) return output;
  return output.slice(0, maxChars) + `\n... [truncated, ${totalChars} chars total]`;
}

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
