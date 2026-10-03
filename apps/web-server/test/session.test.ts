import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/session.js";
import { ApprovalCoordinator } from "../src/approval.js";
import type { ChatMessage, TurnLock, WebTurnRunner } from "../src/types.js";
import type { WebEvent } from "../src/bridge.js";
import { makeTestSessionStore } from "./helpers.js";

function fakeLock(): TurnLock {
  return { withLock: async <T,>(fn: () => Promise<T>) => fn() };
}

function fakeRunner(): WebTurnRunner {
  return {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: vi.fn(async (messages: ChatMessage[], text: string) => {
      messages.push({ role: "user", content: text });
      messages.push({ role: "assistant", content: `reply:${text}` });
    }),
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-session-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("SessionManager", () => {
  it("create 建立会话并挂到 runner", async () => {
    const runner = fakeRunner();
    const manager = new SessionManager(
      runner,
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    const handle = await manager.create(tmpDir);

    expect(handle.messages).toEqual([{ role: "system", content: "sys" }]);
    expect(runner.sessionStore?.path).toBe(handle.file);
    expect(manager.list()).toEqual([handle]);
    expect(manager.get(handle.id)).toBe(handle);
  });

  it("runTurn 在锁内跑轮次", async () => {
    const runner = fakeRunner();
    const manager = new SessionManager(
      runner,
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    const handle = await manager.create(tmpDir);

    await manager.runTurn(handle.id, "hi");
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(handle.messages.map((m) => m.content)).toContain("reply:hi");
  });

  it("session 切换等待运行中的回合并使旧会话排队回合失效", async () => {
    let turnStarted!: () => void;
    const turnStartedGate = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });
    let releaseTurn!: () => void;
    const turnBlocker = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const runner: WebTurnRunner = {
      newSession: () => [{ role: "system", content: "sys" }],
      runTurn: vi.fn(async (messages: ChatMessage[], text: string) => {
        messages.push({ role: "user", content: text });
        messages.push({ role: "assistant", content: `reply:${text}` });
        turnStarted();
        await turnBlocker;
      }),
    };
    let tail: Promise<unknown> = Promise.resolve();
    const lock: TurnLock = {
      withLock: <T,>(fn: () => Promise<T>): Promise<T> => {
        const result = tail.then(() => fn());
        tail = result.catch(() => {});
        return result;
      },
    };
    const manager = new SessionManager(runner, lock, () => {}, new ApprovalCoordinator(() => {}), makeTestSessionStore());
    const oldHandle = await manager.create(tmpDir);

    const firstTurn = manager.runTurn(oldHandle.id, "first");
    await turnStartedGate;
    const switchedSession = manager.create(tmpDir);
    const staleTurn = manager.runTurn(oldHandle.id, "late");
    releaseTurn();

    await firstTurn;
    const newHandle = await switchedSession;
    await expect(staleTurn).rejects.toThrow("no such session");
    expect(oldHandle.messages.map((message) => message.content)).toContain("reply:first");
    expect(newHandle.messages).toEqual([{ role: "system", content: "sys" }]);
    expect(manager.list()).toEqual([newHandle]);
  });

  it("resume 载入历史消息并继续同一文件", async () => {
    const runner = fakeRunner();
    const manager = new SessionManager(
      runner,
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    const store = (await manager.create(tmpDir)).store;
    store.append({ role: "user", content: "old" });

    const handle = await manager.resume(tmpDir, path.basename(store.path));
    expect(handle.messages.map((m) => m.content)).toEqual(["sys", "old"]);
    expect(runner.sessionStore?.path).toBe(store.path);
  });

  it("resume 拒绝路径穿越", async () => {
    const manager = new SessionManager(
      fakeRunner(),
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    await expect(manager.resume(tmpDir, "../etc/passwd")).rejects.toThrow("invalid session file");
  });

  it("approve 应答待审批请求", async () => {
    const events: WebEvent[] = [];
    const approvals = new ApprovalCoordinator((e) => events.push(e));
    const manager = new SessionManager(fakeRunner(), fakeLock(), (e) => events.push(e), approvals, makeTestSessionStore());

    const promise = approvals.ask({ tool: "bash", target: "ls", args: {} });
    const requestId = (events[0] as { requestId: string }).requestId;
    expect(manager.approve(requestId, "allow")).toBe(true);
    await expect(promise).resolves.toBe("allow");
  });

  it("dispose 清空当前会话", async () => {
    const manager = new SessionManager(
      fakeRunner(),
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    const handle = await manager.create(tmpDir);
    await manager.dispose(handle.id);
    expect(manager.list()).toEqual([]);
  });

  it("remove 删除当前会话后跳到剩余最新会话", async () => {
    const manager = new SessionManager(
      fakeRunner(),
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    const first = await manager.create(tmpDir);
    const second = await manager.create(tmpDir); // 当前会话
    expect(existsSync(second.file)).toBe(true);

    await manager.remove(tmpDir, path.basename(second.file));

    expect(existsSync(second.file)).toBe(false);
    const [cur] = manager.list();
    expect(cur!.file).toBe(first.file);
  });

  it("remove 删除唯一会话后新建空会话", async () => {
    const manager = new SessionManager(
      fakeRunner(),
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    const handle = await manager.create(tmpDir);
    await manager.remove(tmpDir, path.basename(handle.file));

    expect(existsSync(handle.file)).toBe(false);
    const [cur] = manager.list();
    expect(cur).toBeDefined();
    expect(cur!.file).not.toBe(handle.file);
    expect(cur!.messages).toEqual([{ role: "system", content: "sys" }]);
  });

  it("remove 删除非当前会话不影响当前会话", async () => {
    const manager = new SessionManager(
      fakeRunner(),
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    const first = await manager.create(tmpDir);
    const second = await manager.create(tmpDir); // 当前会话
    await manager.remove(tmpDir, path.basename(first.file));

    expect(existsSync(first.file)).toBe(false);
    const [cur] = manager.list();
    expect(cur!.file).toBe(second.file);
  });

  it("remove 拒绝路径穿越", async () => {
    const manager = new SessionManager(
      fakeRunner(),
      fakeLock(),
      () => {},
      new ApprovalCoordinator(() => {}),
      makeTestSessionStore(),
    );
    await expect(manager.remove(tmpDir, "../etc/passwd")).rejects.toThrow("invalid session file");
  });

  it("stop 在无运行轮次时返回 false", async () => {
    const manager = new SessionManager(fakeRunner(), fakeLock(), () => {}, new ApprovalCoordinator(() => {}), makeTestSessionStore());
    await manager.create(tmpDir);
    expect(manager.stop()).toBe(false);
  });

  it("stop 触发正在运行轮次的 signal", async () => {
    let seenSignal: AbortSignal | undefined;
    const runner: WebTurnRunner = {
      newSession: () => [{ role: "system", content: "sys" }],
      runTurn: vi.fn(async (_messages, _text, _events, signal) => {
        seenSignal = signal;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      }),
    };
    const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}), makeTestSessionStore());
    const handle = await manager.create(tmpDir);
    const run = manager.runTurn(handle.id, "hi");
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.stop()).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    await run;
  });

  it("stop 中断正在运行的轮次而非排队中的轮次", async () => {
    let turn1Started!: () => void;
    const turn1Gate = new Promise<void>((resolve) => { turn1Started = resolve; });
    let releaseTurn1!: () => void;
    const turn1Blocker = new Promise<void>((resolve) => { releaseTurn1 = resolve; });

    const signals: AbortSignal[] = [];
    const runner: WebTurnRunner = {
      newSession: () => [{ role: "system", content: "sys" }],
      runTurn: vi.fn(async (_messages, _text, _events, signal) => {
        signals.push(signal!);
        if (signals.length === 1) {
          turn1Started();
          await turn1Blocker; // 第一轮持有锁并阻塞，模拟正在运行
        }
      }),
    };

    // 真实串行锁：后一轮排队，等前一轮完成才执行
    let tail: Promise<unknown> = Promise.resolve();
    const lock: TurnLock = {
      withLock: <T,>(fn: () => Promise<T>): Promise<T> => {
        const result = tail.then(() => fn());
        tail = result.catch(() => {});
        return result;
      },
    };

    const manager = new SessionManager(runner, lock, () => {}, new ApprovalCoordinator(() => {}), makeTestSessionStore());
    const handle = await manager.create(tmpDir);

    const run1 = manager.runTurn(handle.id, "one");
    await turn1Gate; // 等第一轮真正开始
    void manager.runTurn(handle.id, "two"); // 第二轮排队

    expect(manager.stop()).toBe(true);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(1); // 第二轮尚未开始

    releaseTurn1();
    await run1;
  });

  it("stop 拒绝待审批请求", async () => {
    const approvals = new ApprovalCoordinator(() => {});
    let decision: string | undefined;
    const runner: WebTurnRunner = {
      newSession: () => [{ role: "system", content: "sys" }],
      runTurn: vi.fn(async (_messages, _text, _events, _signal) => {
        decision = await approvals.ask({ tool: "bash", target: "ls", args: {} });
      }),
    };
    const manager = new SessionManager(runner, fakeLock(), () => {}, approvals, makeTestSessionStore());
    const handle = await manager.create(tmpDir);
    const run = manager.runTurn(handle.id, "hi");
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.stop()).toBe(true);
    await run;
    expect(decision).toBe("deny");
  });
});
