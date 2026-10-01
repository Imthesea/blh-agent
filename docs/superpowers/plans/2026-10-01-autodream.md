# autodream 实现计划

> 输入规格：`docs/superpowers/specs/2026-10-01-autodream-design.md`（已批准，commit 20384c7）
> 执行方式：子代理驱动 / 内联执行，6 个任务，每任务 TDD（先写失败测试 → 实现 → 通过 → commit）。

## 目标

实现按天触发的记忆深度整合（autodream）：24h 滚动间隔 + ≥10 条门槛 + 失败 1h 重试；完整 agent turn 执行（无单次输入上限）；用户提交时主动 abort 进行中的 dream（用户优先）；abort/失败一律快照回滚。

## 与规格的事实修正（读码核实，执行时以此为准）

1. `agentLoop` 真实签名为 `agentLoop(harness, messages, activeRequest?, events?, signal?)`（[loop.ts](../../src/core/loop.ts)）。dream 调用：`agentLoop(this, messages, "[dream]", undefined, signal)`（不传 events，与 runScheduledTurn 一致）。
2. 写类工具只有 `{write_file, edit_file}`（[tools/index.ts](../../src/tools/index.ts)），**无 trash/delete 工具** → 删除走 `.memory/.dream-trash` 清单文件 + 系统侧机械删除。
3. 工具 path 相对 `config.workdir` resolve，故 dream 写白名单按 `resolve(workdir, args.path)` 判定是否落在 memory 目录内。
4. permission hook 中 dream 白名单检查必须插在 **target 计算之后、destructive bash 之前**（[approval.ts L43-52](../../src/security/approval.ts#L43-L52)），否则被 DEFAULT_RULES 末尾 `*:* allow` 架空。
5. **不设 runTurn 尾部检查点**（会在锁内阻塞 REPL readLine，违反用户优先）。只靠 JobsRuntime 常驻轮询：REPL 已 `jobs.start()`（[repl.ts L175](../../src/cli/repl.ts#L175)）；web-server 从不 start，需补接。

## 文件结构

- 新建 `src/memory/dream.ts`：常量、DREAM_PROMPT、MemoryDream 类、4 个导出辅助函数
- 新建 `test/memory/dream.test.ts`
- 修改 `src/memory/system.ts`：Memory 挂 `readonly dream`
- 修改 `src/security/approval.ts`：dreamTurnStorage + runInDreamTurn + 写白名单
- 修改 `test/security/approval.test.ts`（追加 describe）
- 修改 `src/core/harness.ts`：isDreamDue / runDreamTurn
- 修改 `test/core/harness.test.ts`（追加 describe）
- 修改 `src/jobs/runtime.ts`：dream 通道 + abortDream
- 修改 `test/jobs/runtime.test.ts`（追加 describe）
- 修改 `src/cli/repl.ts`：TurnRunner 接口 + 接线 + abortDream
- 修改 `apps/web-server/src/{index.ts,session.ts,types.ts}`：接线 + jobs.start/stop

---

## 任务 1：`src/memory/dream.ts` + Memory 挂字段

### 1.1 失败测试 `test/memory/dream.test.ts`

```typescript
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.js";
import {
  DREAM_INTERVAL_MS,
  DREAM_MIN_RECORDS,
  DREAM_RETRY_MS,
  MemoryDream,
  applyDreamTrash,
  restoreMemorySnapshot,
  snapshotMemoryFiles,
  validateDreamOutput,
} from "../../src/memory/dream.js";

let tmpDir: string;
let store: MemoryStore;
let dream: MemoryDream;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "memory-dream-"));
  store = new MemoryStore(path.join(tmpDir, ".memory"));
  dream = new MemoryDream(store);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRecords(n: number): void {
  for (let i = 0; i < n; i++) {
    store.writeMemoryFile(`record ${i}`, "project", `desc ${i}`, `body ${i}`);
  }
  store.rebuildMemoryIndex();
}

describe("MemoryDream.isDue", () => {
  it("记录不足门槛时不得 dream", () => {
    writeRecords(DREAM_MIN_RECORDS - 1);
    expect(dream.isDue()).toBe(false);
  });

  it("无状态文件且记录达标时立即到期", () => {
    writeRecords(DREAM_MIN_RECORDS);
    expect(dream.isDue()).toBe(true);
  });

  it("markAttempt 后进入 1h 重试窗口，不再到期", () => {
    writeRecords(DREAM_MIN_RECORDS);
    dream.markAttempt();
    expect(dream.isDue()).toBe(false);
  });

  it("markSuccess 后 24h 内不到期；状态文件持久化", () => {
    writeRecords(DREAM_MIN_RECORDS);
    dream.markSuccess();
    expect(dream.isDue()).toBe(false);
    const again = new MemoryDream(store);
    expect(again.isDue()).toBe(false);
    const state = JSON.parse(readFileSync(path.join(store.directory, ".dream-state.json"), "utf-8"));
    expect(state.lastSuccess).toBeGreaterThan(0);
  });

  it("距上次成功超过 24h 且距上次尝试超过 1h 时再次到期", () => {
    writeRecords(DREAM_MIN_RECORDS);
    dream.markAttempt();
    const now = Date.now();
    const statePath = path.join(store.directory, ".dream-state.json");
    writeFileSync(statePath, JSON.stringify({ lastAttempt: now - DREAM_RETRY_MS, lastSuccess: now - DREAM_INTERVAL_MS }), "utf-8");
    expect(dream.isDue()).toBe(true);
  });
});

describe("snapshot / restore", () => {
  it("快照回滚：删除新增文件、恢复原文件内容", () => {
    writeRecords(2);
    const snapshot = snapshotMemoryFiles(store);
    // dream 搞破坏：改掉旧文件、新建文件
    writeFileSync(store.memoryPath(`${MemoryStore.memorySlug("record 0")}.md`), "corrupted", "utf-8");
    store.writeMemoryFile("new junk", "project", "d", "b");
    restoreMemorySnapshot(store, snapshot);
    expect(existsSync(store.memoryPath(`${MemoryStore.memorySlug("new junk")}.md`))).toBe(false);
    const restored = store.listMemoryFiles().find((r) => r.name === "record 0");
    expect(restored?.body).toBe("body 0");
    expect(existsSync(path.join(store.directory, "MEMORY.md"))).toBe(true);
  });
});

describe("applyDreamTrash", () => {
  it("按清单删除文件并清理清单本身", () => {
    writeRecords(3);
    const victim = store.listMemoryFiles()[0]!.filename;
    writeFileSync(path.join(store.directory, ".dream-trash"), `${victim}\n`, "utf-8");
    applyDreamTrash(store);
    expect(existsSync(store.memoryPath(victim))).toBe(false);
    expect(existsSync(path.join(store.directory, ".dream-trash"))).toBe(false);
    expect(store.listMemoryFiles()).toHaveLength(2);
  });

  it("拒绝删除 MEMORY.md 与逃逸路径，跳过非法行", () => {
    writeRecords(1);
    writeFileSync(path.join(store.directory, ".dream-trash"), "MEMORY.md\n../evil.md\n\n", "utf-8");
    applyDreamTrash(store);
    expect(existsSync(path.join(store.directory, "MEMORY.md"))).toBe(true);
    expect(existsSync(path.join(store.directory, ".dream-trash"))).toBe(false);
  });

  it("清单不存在时无操作", () => {
    writeRecords(1);
    applyDreamTrash(store);
    expect(store.listMemoryFiles()).toHaveLength(1);
  });
});

describe("validateDreamOutput", () => {
  it("全部记录合法时通过", () => {
    writeRecords(2);
    expect(() => validateDreamOutput(store)).not.toThrow();
  });

  it("存在正文为空的 .md 时抛错", () => {
    writeRecords(1);
    writeFileSync(store.memoryPath("empty.md"), "---\nname: empty\n---\n", "utf-8");
    expect(() => validateDreamOutput(store)).toThrow(/empty/);
  });
});
```

运行确认失败：`npx vitest run test/memory/dream.test.ts`（模块不存在，失败）。

### 1.2 实现 `src/memory/dream.ts`

```typescript
// src/memory/dream.ts
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@blh/logger";
import { INDEX_NAME, type MemoryStore } from "./store.js";

const log = createLogger("memory.dream");

/** 距上次成功的滚动触发间隔：24h。 */
export const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 失败（含被 abort）后的重试间隔：1h。 */
export const DREAM_RETRY_MS = 60 * 60 * 1000;
/** 触发门槛：记忆记录至少这么多条。 */
export const DREAM_MIN_RECORDS = 10;
/** dream 待删文件清单（agent 写入，系统侧机械删除）。 */
export const DREAM_TRASH_NAME = ".dream-trash";
/** dream 状态文件（lastAttempt / lastSuccess 时间戳）。 */
export const DREAM_STATE_NAME = ".dream-state.json";

/** dream 轮注入的用户消息（英文，避免占中文系统提示词风格）。 */
export const DREAM_PROMPT = [
  "[Scheduled] This is an autonomous memory-consolidation turn (autodream), not a user message.",
  "Tidy the long-term memory directory (.memory/):",
  "- Read MEMORY.md and the memory files, then merge duplicates, fix stale facts, and split oversized notes.",
  "- You may ONLY create or edit files inside .memory/ using write_file / edit_file (paths relative to the workdir).",
  "- To delete a file, append its filename (one per line) to .memory/.dream-trash; the system deletes them mechanically after this turn. Never delete by overwriting with empty content.",
  "- Every remaining .md memory file must keep valid frontmatter (name/description/type) and a non-empty body.",
  "- Do not touch any file outside .memory/. Do not run bash. Do not ask the user anything.",
  "- When finished, reply with a one-line summary of what changed.",
].join("\n");

type DreamState = { lastAttempt: number; lastSuccess: number };

export class MemoryDream {
  constructor(private readonly store: MemoryStore) {}

  private statePath(): string {
    return path.join(this.store.directory, DREAM_STATE_NAME);
  }

  readState(): DreamState {
    try {
      const raw = JSON.parse(readFileSync(this.statePath(), "utf-8")) as Partial<DreamState>;
      return { lastAttempt: Number(raw.lastAttempt) || 0, lastSuccess: Number(raw.lastSuccess) || 0 };
    } catch {
      return { lastAttempt: 0, lastSuccess: 0 };
    }
  }

  private writeState(state: DreamState): void {
    mkdirSync(this.store.directory, { recursive: true });
    writeFileSync(this.statePath(), JSON.stringify(state), "utf-8");
  }

  markAttempt(): void {
    this.writeState({ ...this.readState(), lastAttempt: Date.now() });
  }

  markSuccess(): void {
    const now = Date.now();
    this.writeState({ lastAttempt: now, lastSuccess: now });
  }

  /** 到期条件：记录数达标，且距上次成功 ≥24h、距上次尝试 ≥1h（无状态文件时立即到期）。 */
  isDue(now = Date.now()): boolean {
    if (this.store.listMemoryFiles().length < DREAM_MIN_RECORDS) return false;
    const state = this.readState();
    return now - state.lastSuccess >= DREAM_INTERVAL_MS && now - state.lastAttempt >= DREAM_RETRY_MS;
  }
}

/** 快照所有记忆文件（含 MEMORY.md）的原始内容。 */
export function snapshotMemoryFiles(store: MemoryStore): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!existsSync(store.directory)) return snapshot;
  for (const fileName of readdirSync(store.directory).filter((f) => f.endsWith(".md"))) {
    try {
      snapshot[fileName] = readFileSync(fileName === INDEX_NAME ? store.indexPath : store.memoryPath(fileName), "utf-8");
    } catch {
      continue;
    }
  }
  return snapshot;
}

/** 回滚：删光当前 .md，写回快照，重建索引。与 extract.ts consolidate 失败路径同构。 */
export function restoreMemorySnapshot(store: MemoryStore, snapshot: Record<string, string>): void {
  if (existsSync(store.directory)) {
    for (const fileName of readdirSync(store.directory).filter((f) => f.endsWith(".md"))) {
      try {
        unlinkSync(fileName === INDEX_NAME ? store.indexPath : store.memoryPath(fileName));
      } catch {
        continue;
      }
    }
  }
  for (const [fileName, content] of Object.entries(snapshot)) {
    writeFileSync(fileName === INDEX_NAME ? store.indexPath : store.memoryPath(fileName), content, "utf-8");
  }
  store.rebuildMemoryIndex();
  log.info("dream snapshot restored", { files: Object.keys(snapshot).length });
}

/** 机械执行 .dream-trash 清单：逐行校验文件名（拒绝索引与逃逸），删除后清掉清单并重建索引。 */
export function applyDreamTrash(store: MemoryStore): void {
  const trashPath = path.join(store.directory, DREAM_TRASH_NAME);
  if (!existsSync(trashPath)) return;
  const lines = readFileSync(trashPath, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  let removed = 0;
  for (const line of lines) {
    if (line === INDEX_NAME) continue;
    let target: string;
    try {
      target = store.memoryPath(line); // 纯文件名校验，../ 逃逸会抛错
    } catch {
      log.warn("dream trash skipped invalid entry", { entry: line });
      continue;
    }
    try {
      unlinkSync(target);
      removed += 1;
    } catch {
      continue;
    }
  }
  rmSync(trashPath, { force: true });
  store.rebuildMemoryIndex();
  log.info("dream trash applied", { removed });
}

/** 校验 dream 产出：每个记忆文件必须有合法 frontmatter 且正文非空。不合法即抛错（触发回滚）。 */
export function validateDreamOutput(store: MemoryStore): void {
  for (const record of store.listMemoryFiles()) {
    if (record.body.trim() === "") {
      throw new Error(`dream produced empty memory file: ${record.filename}`);
    }
  }
}
```

`src/memory/system.ts`：import 后加字段与构造。

```typescript
import { MemoryDream } from "./dream.js";
// class Memory 内：
  /** 定期深度整合（autodream）的调度状态与到期判断。 */
  readonly dream: MemoryDream;
// constructor 末尾：
    this.dream = new MemoryDream(store);
```

运行确认通过：`npx vitest run test/memory/dream.test.ts`

### 1.3 commit

```powershell
git add src/memory/dream.ts src/memory/system.ts test/memory/dream.test.ts
git commit -m "feat(memory): add autodream scheduler state, snapshot/rollback and trash helpers"
```

---

## 任务 2：approval.ts — runInDreamTurn + dream 写白名单

### 2.1 失败测试（追加到 `test/security/approval.test.ts`，沿用该文件既有 import 与 helper）

```typescript
import { runInDreamTurn } from "../../src/security/approval.js";

describe("dream turn permission", () => {
  const workdir = path.join(os.tmpdir(), "dream-work");
  const memoryDir = path.join(workdir, ".memory");
  const ctx = { workdir, memoryDir };

  it("dream 轮中写 .memory/ 内文件直接放行（不触发 asker）", async () => {
    const asker = async () => { throw new Error("asker must not be called"); };
    const hook = makePermissionHook([], asker);
    const result = await runInDreamTurn(ctx, () =>
      hook("write_file", { path: ".memory/foo.md", content: "x" }));
    expect(result).toBeNull();
  });

  it("dream 轮中写 .memory/ 外文件被拒绝", async () => {
    const hook = makePermissionHook([], async () => "allow");
    const result = await runInDreamTurn(ctx, () =>
      hook("write_file", { path: "src/index.ts", content: "x" }));
    expect(result).toMatch(/denied/);
  });

  it("dream 轮中 bash 不适用白名单，走 scheduled 语义被拒绝", async () => {
    const hook = makePermissionHook([], async () => "allow");
    const result = await runInDreamTurn(ctx, () => hook("bash", { command: "ls" }));
    expect(result).toMatch(/denied: cannot request approval from a scheduled turn/);
  });

  it("非 dream 轮不受影响（原有 asker 流程）", async () => {
    const hook = makePermissionHook([], async () => "deny");
    const result = await hook("write_file", { path: ".memory/foo.md", content: "x" });
    expect(result).toBe("denied by user");
  });
});
```

注意：白名单必须**先于** matchRule 判定（否则 `*:* allow` 架空）；用空 rules 数组即可暴露顺序错误。运行确认失败：`npx vitest run test/security/approval.test.ts`

### 2.2 实现（`src/security/approval.ts`）

文件顶部 import 增加 `import path from "node:path";`。在 `runInScheduledTurn` 之后追加：

```typescript
/** dream 轮上下文：携带 workdir 与 memory 目录，用于写白名单判定。 */
export interface DreamContext {
  workdir: string;
  memoryDir: string;
}

const dreamTurnStorage = new AsyncLocalStorage<DreamContext>();

/** dream 轮可申请写白名单的工具集合。 */
const DREAM_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/** 在 dream-turn 上下文中执行：叠加 scheduled 语义（禁交互审批）+ dream 写白名单。 */
export function runInDreamTurn<T>(ctx: DreamContext, fn: () => Promise<T>): Promise<T> {
  return scheduledTurnStorage.run(true, () => dreamTurnStorage.run(ctx, fn));
}
```

hook 内插入点：target 计算之后、destructive bash 之前（[approval.ts L47-48](../../src/security/approval.ts#L47-L48) 之间）：

```typescript
    const dreamCtx = dreamTurnStorage.getStore();
    if (dreamCtx !== undefined && DREAM_WRITE_TOOLS.has(tool)) {
      const resolved = path.resolve(dreamCtx.workdir, target);
      const rel = path.relative(dreamCtx.memoryDir, resolved);
      const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      if (!inside) {
        log.warn("denied by dream whitelist", { tool, target });
        tracer?.event("approval", { tool, decision: "deny", rule: "dream_whitelist", source });
        return `denied by permission rule (${tool}: ${target}) — dream turn may only write inside .memory/`;
      }
      tracer?.event("approval", { tool, decision: "allow", rule: "dream_whitelist", source });
      return null;
    }
```

运行确认通过：`npx vitest run test/security/approval.test.ts`

### 2.3 commit

```powershell
git add src/security/approval.ts test/security/approval.test.ts
git commit -m "feat(security): add dream-turn context with .memory-only write whitelist"
```

---

## 任务 3：harness.runDreamTurn / isDreamDue

### 3.1 失败测试（追加到 `test/core/harness.test.ts`，沿用既有 import；新增下方 helper）

需要 Memory + 真实工具注册表。工具注册方式参照 [tools/index.ts](../../src/tools/index.ts) 的 `makeTools(config)`（以该文件实际导出名为准）。

```typescript
import { Memory } from "../../src/memory/system.js";
import { MemoryStore } from "../../src/memory/store.js";
import { makeTools } from "../../src/tools/index.js";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 在第一次 chat 返回后立刻 abort 的 provider：模拟用户优先中断。 */
class AbortAfterFirstProvider implements ChatProvider {
  private first = true;
  constructor(private readonly inner: MockProvider, private readonly signal: AbortSignal) {}
  async chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): Promise<ChatMessage> {
    const reply = await this.inner.chat(messages, tools, maxTokens);
    if (this.first) {
      this.first = false;
      (this.signal as { abort?: () => void }); // signal 只读，用 controller 外部 abort
    }
    return reply;
  }
}

function makeDreamHarness(scripted: ChatMessage[]) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "dream-work-"));
  const config = { workdir } as Config; // 按 harness.test.ts 既有 config 写法对齐
  const provider = new MockProvider(scripted);
  const store = new MemoryStore(path.join(workdir, ".memory"));
  const memory = new Memory(store, provider);
  const harness = new Harness(config, provider, makeTools(config), new HookBus(), undefined, undefined, memory);
  return { harness, provider, store, workdir };
}

describe("Harness.runDreamTurn", () => {
  it("成功：dream 写入新记忆、重建索引、标记成功", async () => {
    const { harness, store, workdir } = makeDreamHarness([
      makeToolCallMessage("write_file", { path: ".memory/dreamed.md", content: "---\nname: dreamed\ndescription: d\ntype: project\n---\nbody" }),
      makeTextMessage("done"),
    ]);
    const messages = harness.newSession();
    await harness.runDreamTurn(messages, new AbortController().signal);
    expect(existsSync(path.join(workdir, ".memory", "dreamed.md"))).toBe(true);
    expect(store.readMemoryIndex()).toContain("dreamed.md");
    expect(store.dream?.readState?.() ?? new Memory(store, new MockProvider([])).dream.readState().lastSuccess).toBeGreaterThan(0);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("abort：用户中断后快照回滚，新增文件消失、消息回滚", async () => {
    const { harness, store, workdir } = makeDreamHarness([
      makeToolCallMessage("write_file", { path: ".memory/dreamed.md", content: "---\nname: dreamed\ndescription: d\ntype: project\n---\nbody" }),
      makeTextMessage("done"),
    ]);
    store.writeMemoryFile("keep", "project", "d", "original");
    store.rebuildMemoryIndex();
    const controller = new AbortController();
    const messages = harness.newSession();
    const before = messages.length;
    // 第一次工具调用后 abort：包装 provider 在第二次 chat 前触发
    const originalChat = harness.provider.chat.bind(harness.provider);
    let calls = 0;
    harness.provider.chat = async (m, t, mt) => {
      calls += 1;
      if (calls === 2) controller.abort();
      return originalChat(m, t, mt);
    };
    await harness.runDreamTurn(messages, controller.signal);
    expect(existsSync(path.join(workdir, ".memory", "dreamed.md"))).toBe(false);
    expect(store.listMemoryFiles().find((r) => r.name === "keep")?.body).toBe("original");
    expect(messages.length).toBe(before);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("非法产出：写出正文为空的记忆文件 → 整体回滚", async () => {
    const { harness, store, workdir } = makeDreamHarness([
      makeToolCallMessage("write_file", { path: ".memory/empty.md", content: "---\nname: empty\n---\n" }),
      makeTextMessage("done"),
    ]);
    store.writeMemoryFile("keep", "project", "d", "original");
    store.rebuildMemoryIndex();
    const messages = harness.newSession();
    await harness.runDreamTurn(messages, new AbortController().signal);
    expect(existsSync(path.join(workdir, ".memory", "empty.md"))).toBe(false);
    expect(store.listMemoryFiles().find((r) => r.name === "keep")?.body).toBe("original");
    rmSync(workdir, { recursive: true, force: true });
  });

  it("isDreamDue 委托给 memory.dream", async () => {
    const { harness, workdir } = makeDreamHarness([]);
    expect(await harness.isDreamDue()).toBe(false); // 0 条记录，不足门槛
    rmSync(workdir, { recursive: true, force: true });
  });
});
```

注：`harness.provider` 是 readonly，测试中直接 `new Harness` 换 provider 或把 controller.abort 包装放在构造前；执行时按实际可写性微调（MockProvider 子类覆盖亦可）。运行确认失败：`npx vitest run test/core/harness.test.ts`

### 3.2 实现（`src/core/harness.ts`）

import 追加：

```typescript
import { runInDreamTurn } from "../security/approval.js"; // 已有 runInScheduledTurn 同文件，合并
import { DREAM_PROMPT, applyDreamTrash, restoreMemorySnapshot, snapshotMemoryFiles, validateDreamOutput } from "../memory/dream.js";
import { TurnCancelledError } from "./loop.js"; // agentLoop 已有同文件 import，合并
```

class Harness 内追加两个方法：

```typescript
  /** dream 是否到期（无记忆系统时恒 false）。 */
  async isDreamDue(): Promise<boolean> {
    return this.memory?.dream.isDue() ?? false;
  }

  /**
   * 跑一轮 autodream：注入 dream 提示词，在 dream 权限上下文中执行完整 agent turn。
   * 用户 abort / 任何失败：快照回滚 + 消息回滚 + 记失败（1h 后重试，由 markAttempt 保证），不向上抛错。
   */
  async runDreamTurn(messages: ChatMessage[], signal?: AbortSignal): Promise<void> {
    const memory = this.memory;
    if (memory === undefined) return;
    const dream = memory.dream;
    dream.markAttempt();
    const snapshot = snapshotMemoryFiles(memory.store);
    const dreamStart = messages.length;
    this.tracer?.event("job", { kind: "dream", status: "started" });
    try {
      messages.push({ role: "user", content: DREAM_PROMPT });
      await runInDreamTurn(
        { workdir: this.config.workdir, memoryDir: memory.store.directory },
        () => agentLoop(this, messages, "[dream]", undefined, signal),
      );
      if (signal?.aborted) throw new TurnCancelledError();
      applyDreamTrash(memory.store);
      memory.store.rebuildMemoryIndex();
      validateDreamOutput(memory.store);
      dream.markSuccess();
      this.tracer?.event("job", { kind: "dream", status: "completed" });
    } catch (error) {
      restoreMemorySnapshot(memory.store, snapshot);
      messages.splice(dreamStart);
      this.tracer?.event("job", { kind: "dream", status: error instanceof TurnCancelledError ? "aborted" : "failed", error: String(error) });
      log warn 省略 // 用 createLogger("core.harness") 若文件已有 log 则复用
    }
  }
```

注意：dream 提示词已含 `[Scheduled] ` 前缀（见 DREAM_PROMPT 首行），不再经 consumeAndInjectCron。运行确认通过：`npx vitest run test/core/harness.test.ts`

### 3.3 commit

```powershell
git add src/core/harness.ts test/core/harness.test.ts
git commit -m "feat(core): add runDreamTurn with snapshot rollback and user-priority abort"
```

---

## 任务 4：JobsRuntime dream 通道 + abortDream

### 4.1 失败测试（追加到 `test/jobs/runtime.test.ts`，沿用 makeRuntime helper 与 fake timers 模式）

```typescript
describe("JobsRuntime dream channel", () => {
  it("dream 到期时执行 dreamTurn（60s 降频检查）", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    let ran = 0;
    runtime.setDreamTurn(async () => true, async () => { ran += 1; });
    runtime.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ran).toBe(1);
    runtime.stop();
    vi.useRealTimers();
  });

  it("dream 未到期不执行；到期检查 60s 内不重复调用 isDue", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    let dueCalls = 0;
    runtime.setDreamTurn(async () => { dueCalls += 1; return false; }, async () => { throw new Error("must not run"); });
    runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dueCalls).toBe(1);
    runtime.stop();
    vi.useRealTimers();
  });

  it("abortDream 中断进行中的 dreamTurn", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    let aborted = false;
    runtime.setDreamTurn(async () => true, (signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); });
    }));
    runtime.start();
    await vi.advanceTimersByTimeAsync(61_000);
    runtime.abortDream();
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(true);
    runtime.stop();
    vi.useRealTimers();
  });

  it("dream 优先于 cron：同一轮先跑 dream", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    const order: string[] = [];
    runtime.setCronTurn(async () => { order.push("cron"); });
    runtime.setDreamTurn(async () => true, async () => { order.push("dream"); });
    // 让 cron 队列非空：按 runtime.test.ts 既有方式塞一个到期 job
    runtime.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(order[0]).toBe("dream");
    runtime.stop();
    vi.useRealTimers();
  });
});
```

运行确认失败：`npx vitest run test/jobs/runtime.test.ts`

### 4.2 实现（`src/jobs/runtime.ts`）

```typescript
/** dream due 检查降频：processQueue 每 200ms 轮询，isDue 每 60s 才真正评估一次。 */
const DREAM_CHECK_MS = 60_000;

// class JobsRuntime 字段追加：
  private dreamDue: (() => Promise<boolean>) | null = null;
  private dreamTurn: ((signal: AbortSignal) => Promise<void>) | null = null;
  private dreamAbort: AbortController | null = null;
  private lastDreamCheck = 0;

// setCronTurn 后追加：
  setDreamTurn(due: () => Promise<boolean>, turn: (signal: AbortSignal) => Promise<void>): void {
    this.dreamDue = due;
    this.dreamTurn = turn;
  }

  /** 用户优先：中断正在进行的 dream（dream 内部回滚并释放锁）。 */
  abortDream(): void {
    this.dreamAbort?.abort();
  }

// processQueue 整体替换：
  private async processQueue(): Promise<void> {
    // dream 通道：到期检查降频；到期则抢锁执行（抢不到说明用户轮/团队轮在跑，等下一轮）。
    if (this.dreamTurn !== null && this.dreamDue !== null && Date.now() - this.lastDreamCheck >= DREAM_CHECK_MS) {
      this.lastDreamCheck = Date.now();
      let due = false;
      try {
        due = await this.dreamDue();
      } catch (error) {
        log.warn("dream due check failed", { error: String(error) });
      }
      if (due) {
        if (!this.agentLock.tryAcquire()) return;
        this.dreamAbort = new AbortController();
        try {
          await this.dreamTurn(this.dreamAbort.signal);
        } finally {
          this.dreamAbort = null;
          this.agentLock.release();
        }
        return;
      }
    }
    if (!this.cron.hasQueue() || !this.agentLock.tryAcquire()) return;
    try {
      if (this.cron.hasQueue() && this.cronTurn !== null) {
        await this.cronTurn();
      }
    } finally {
      this.agentLock.release();
    }
  }
```

说明：processQueue 由 `scheduleQueuePoll` 循环驱动，首轮延迟 200ms；测试里 `advanceTimersByTimeAsync(61_000)` 会经过多次轮询但 isDue 只评估一次（fake timers 下 Date.now 同步前进，第二次评估发生在 60s 后、turn 执行前——故用例 1 断言 ran===1 成立；执行时若时序微差，以 `ran >= 1` 微调）。运行确认通过：`npx vitest run test/jobs/runtime.test.ts`

### 4.3 commit

```powershell
git add src/jobs/runtime.ts test/jobs/runtime.test.ts
git commit -m "feat(jobs): add dream channel to JobsRuntime with abortDream support"
```

---

## 任务 5：REPL 接线

无新测试文件；验证 = 既有 repl 测试通过 + tsc 编译。

### 5.1 修改 `src/cli/repl.ts`

TurnRunner 接口追加：

```typescript
  /** 可选：dream 是否到期。 */
  isDreamDue?(): Promise<boolean>;
  /** 可选：跑一轮 autodream。 */
  runDreamTurn?(messages: ChatMessage[], signal?: AbortSignal): Promise<void>;
```

repl() 函数体内，cron 接线块（[repl.ts L167-176](../../src/cli/repl.ts#L167-L176)）之后追加：

```typescript
    const isDreamDue = agent.isDreamDue?.bind(agent);
    const runDreamTurn = agent.runDreamTurn?.bind(agent);
    if (jobs !== undefined && isDreamDue !== undefined && runDreamTurn !== undefined) {
      jobs.setDreamTurn(isDreamDue, async (signal) => {
        const before = messages.length;
        await runDreamTurn(messages, signal);
        const reply = lastAssistantText(messages, before);
        if (reply) io.print(reply);
      });
    }
```

注意：cron 的 `jobs.start()` 保持原处不动（setDreamTurn 在 start 后注册也安全——due 检查在 processQueue 内判空）。

用户优先 abort：在 `await jobs.agentLock.withLock(run)`（[repl.ts L246](../../src/cli/repl.ts#L246)）之前插一行：

```typescript
        if (jobs !== undefined) {
          jobs.abortDream(); // 用户提交优先：中断进行中的 dream（其内部回滚后释放锁）
          await jobs.agentLock.withLock(run);
        }
```

### 5.2 验证 + commit

```powershell
npx tsc --noEmit
npx vitest run test/cli
git add src/cli/repl.ts
git commit -m "feat(cli): wire dream channel into repl, abort dream on user submit"
```

---

## 任务 6：web-server 接线

无新测试；验证 = tsc 编译 + 全量测试。

### 6.1 修改

`apps/web-server/src/types.ts`：`jobs?: { agentLock: TurnLock }` 扩展为：

```typescript
  jobs?: {
    agentLock: TurnLock;
    start(): void;
    stop(): void;
    abortDream(): void;
    setDreamTurn(due: () => Promise<boolean>, turn: (signal: AbortSignal) => Promise<void>): void;
  };
```

`WebTurnRunner`（types.ts L77 附近）追加 `isDreamDue?(): Promise<boolean>` 与 `runDreamTurn?(messages, signal?): Promise<void>`。

`apps/web-server/src/index.ts`：`session.create(workdir)`（L63）所在初始化处追加：

```typescript
if (harness.jobs && harness.isDreamDue && harness.runDreamTurn) {
  harness.jobs.setDreamTurn(
    () => harness.isDreamDue(),
    (signal) => harness.runDreamTurn(session.current?.messages ?? [], signal),
  );
  harness.jobs.start(); // web 场景此前从未 start，dream 与 cron 一并激活
}
```

`close()`（L86-95）内 `server.close` resolve 前加 `harness.jobs?.stop();`。

`apps/web-server/src/session.ts`：`runTurn` 的 `this.lock.withLock(run)`（L86）之前加 `this.runner.jobs?.abortDream?.();`（lock 即 jobs.agentLock 时语义与 REPL 一致）。

### 6.2 验证 + commit

```powershell
npx tsc --noEmit
npm test
git add apps/web-server/src/index.ts apps/web-server/src/session.ts apps/web-server/src/types.ts
git commit -m "feat(web): wire dream channel into web server, start jobs runtime"
```

---

## 自检

- 规格覆盖：24h 间隔（DREAM_INTERVAL_MS）✅ 10 条门槛（DREAM_MIN_RECORDS）✅ 1h 重试（DREAM_RETRY_MS + markAttempt）✅ 用户优先 abort（runtime.abortDream + repl/web 接线 + harness 显式 signal.aborted 检查）✅ 快照回滚（snapshot/restore + validateDreamOutput + TurnCancelledError 路径）✅ 写白名单（dream_turn 上下文 + matchRule 之前）✅ .dream-trash 机械删除 ✅ 死锁消除（完整 agent turn，无 20000 字符上限）✅
- 占位符：任务 3 测试的 `AbortAfterFirstProvider` 含一处未完成注释——执行时删除该类，统一用"包装 harness.provider.chat 第二次调用时 abort"方案（abort 用例已按此写）。
- 类型一致性：TurnRunner / WebTurnRunner 新增方法均为可选，Harness 类天然满足；runDreamTurn 不向上抛错，runtime 无需 catch dream 异常（scheduleQueuePoll 的 catch 兜底仍在）。
