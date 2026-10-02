/**
 * 异步互斥锁基础设施。
 *
 * 为什么不用同步锁：需要互斥的临界区都「跨 await」——用户回合、cron 回合、
 * autodream 回合、teammate 回合都会读写同一个 messages 数组，且中间要等模型
 * 回复、等工具结果。Node 单线程下同步代码块天然原子，但一旦 `await` 让出，
 * 别的回合就会插进来，所以要用 held 标志 + waiters 队列 + Promise 锁住跨越
 * await 的整段执行。
 *
 * 三个入口的语义：
 *  - tryAcquire()：同步抢锁，抢不到立刻返回 false（对应 Python 的
 *    acquire(blocking=False)），用于「有人在跑就本轮跳过」的轮询场景。
 *  - acquire()：抢不到就排队，返回一个 Promise，等前面的人 release 后 resolve。
 *  - release()：交还锁；若有人排队，直接把所有权移交给下一个（held 保持 true，
 *    避免中间出现「无人持锁」的空窗被 tryAcquire 钻空）。
 */
export class AgentLock {
  /** 当前是否有人持锁 */
  private held = false;
  /** 排队等待者的回调队列；每个回调在被调用时会重新置 held=true 并 resolve 对应 acquire */
  private readonly waiters: Array<() => void> = [];

  /** 同步尝试抢锁：没被占用就拿下并返回 true；已被占用则返回 false，不做任何等待。 */
  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  /** 抢锁：空闲则立即 resolve；被占用则把 resolve 压入等待队列，等 release 时被调用。 */
  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.held = true;
        resolve();
      });
    });
  }

  /** 交还锁：有等待者则直接移交所有权给队首（held 保持 true），否则置空闲。 */
  release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.held = false;
    } else {
      next(); // 所有权直接移交，held 保持 true
    }
  }

  /** 便捷封装：acquire → 执行 fn → 无论成败都 finally release。 */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
