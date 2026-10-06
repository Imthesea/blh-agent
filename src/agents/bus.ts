import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";

const VALID_AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** 检查 agent 名字是否合法：只能由字母、数字、下划线、短横线组成，长度 1~64。 */
export function isValidAgentName(name: string): boolean {
  return VALID_AGENT_NAME.test(name);
}

export interface BusMessage {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, unknown>;
}

/** 文件收件箱：单线程下天然线程安全，破坏性读（read 后删除）。 */
export class MessageBus {
  /** 创建消息总线，mailboxDir 是存放各 agent 收件箱文件的目录。 */
  constructor(readonly mailboxDir: string) {}

  /**
   * 根据 agent 名字算出它的收件箱文件路径。
   * 做两道校验：名字必须合法、路径不能逃出邮箱目录（防止用 ../ 之类的名字写穿目录）。
   */
  private pathFor(agent: string): string {
    if (!isValidAgentName(agent)) {
      throw new Error(`Invalid mailbox recipient: ${JSON.stringify(agent)}`);
    }
    const resolved = path.resolve(this.mailboxDir, `${agent}.jsonl`);
    const root = path.resolve(this.mailboxDir);
    if (path.dirname(resolved) !== root) {
      throw new Error(`Mailbox path escapes directory: ${JSON.stringify(agent)}`);
    }
    return resolved;
  }

  /**
   * 给 toAgent 发一条消息：把消息拼成一行 JSON，追加写到它的收件箱文件末尾。
   * 目录不存在时先创建。
   */
  send(
    fromAgent: string,
    toAgent: string,
    content: string,
    type = "message",
    metadata: Record<string, unknown> = {},
  ): void {
    const message: BusMessage = {
      from: fromAgent,
      to: toAgent,
      content,
      type,
      ts: Date.now() / 1000,
      metadata,
    };
    mkdirSync(this.mailboxDir, { recursive: true });
    appendFileSync(this.pathFor(toAgent), JSON.stringify(message) + "\n", "utf8");
  }

  /**
   * 读出 agent 收件箱里的全部消息（每行一条 JSON，逐条解析）。
   * 读完就把文件删掉，保证每条消息只被处理一次。
   */
  readInbox(agent: string): BusMessage[] {
    const inbox = this.pathFor(agent);
    if (!existsSync(inbox)) return [];
    const messages = readFileSync(inbox, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as BusMessage);
    unlinkSync(inbox);
    return messages;
  }

  /** 看 agent 有没有新消息：只看有没有，不取走也不删文件。 */
  peek(agent: string): boolean {
    const inbox = this.pathFor(agent);
    return existsSync(inbox) && statSync(inbox).size > 0;
  }

  /** TS 的轮询等待：无消息时每 20ms 检查一次直到超时。 */
  async waitForMessages(
    agent: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BusMessage[]> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) return [];
      if (this.peek(agent)) return this.readInbox(agent);
      if (deadline !== undefined && Date.now() >= deadline) return [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 20);
        const onAbort = () => done();
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
