# Tracing 体系与观测页 实现计划

> **面向 AI 代理的工作者提示：** 本计划要求使用 superpowers 的 test-driven-development 与 verification-before-completion 技能，按任务逐个执行。严格遵循 TDD：先写失败测试 → 运行验证失败 → 最少实现 → 运行验证通过 → 提交。每个任务中的代码都是完整可用的，禁止留占位符。每完成一个任务立即 commit。

**Goal:** 为 blh-claude-code-ts 建立全链路 tracing 体系（LLM/工具/审批/压缩/记忆/目标/子代理/后台任务/工作流事件 + 永久 token 账本），并在现有 Web 工作台内新增三个只读观测页（Overview / Trace / Ops），方便追踪调查各个环节。

**Architecture:** 独立 `src/tracing/` 模块（同步 JSONL 追加写、失败静默），`Tracer` 经构造器注入 Harness 与各子系统；事件按 `<workdir>/.blh/traces/YYYY-MM-DD.jsonl` 按日分文件，usage 账本永久累积于 `<workdir>/.blh/usage.jsonl`；web-server 以 `TraceModule` 接口依赖反转挂载 4 个只读端点；前端经 `@blh/web-client` 新增 `traceApi`，hash 路由 `#/observe/*` 渲染三个观测页。

**Tech Stack:** TypeScript（Node ≥20，ESM）、Vitest 2、React 18、Node 原生 http（web-server 无框架）、pnpm monorepo。

**规格:** `docs/superpowers/specs/2026-09-27-tracing-dashboard-design.md`

**关键实现约束（执行前必读）：**
- 所有命令在仓库根目录 `f:\allProject\myProject\blh-claude-code-ts` 执行（PowerShell）。
- 每个"运行测试"步骤必须真实执行并核对输出；未达预期即停下调试，不得跳过。
- Tracer 全部 I/O 必须 try/catch 包裹、失败静默（经 logger warn 一次）——观测能力绝不能打爆主流程。
- 每个任务末尾的 commit 步骤必须执行；commit message 按计划原文使用。
- 涉及 web 前端的任务无单测，验证方式为 `pnpm --filter @blh/web typecheck`（任务 19 统一 build 验证）。

---

## 文件结构

### 创建

| 文件 | 职责 |
| --- | --- |
| `src/tracing/types.ts` | TraceEvent / UsageRecord 类型 |
| `src/tracing/pricing.ts` | 模型价格表、成本计算、usage 账本聚合 |
| `src/tracing/tracer.ts` | Tracer：事件写入、turn 聚合、账本记账、summarize |
| `src/tracing/fold.ts` | 事件折叠为 Turn 视图 + trace 文件读取 |
| `src/tracing/module.ts` | TraceModule 实现（web-server 查询接口） |
| `test/tracing/pricing.test.ts` | pricing 单测 |
| `test/tracing/tracer.test.ts` | Tracer 单测 |
| `test/tracing/fold.test.ts` | fold 单测 |
| `test/tracing/module.test.ts` | TraceModule 单测（含 events 游标语义） |
| `apps/web-server/src/trace.ts` | trace API 路由处理器 |
| `apps/web-server/test/trace.test.ts` | trace 路由 wiring / 参数校验测试（stub TraceModule） |
| `packages/web-client/src/trace.ts` | traceApi 客户端 + 镜像类型 |
| `apps/web/src/observe/OverviewPage.tsx` | 观测总览页 |
| `apps/web/src/observe/TracePage.tsx` | Trace 时间线页 |
| `apps/web/src/observe/OpsPage.tsx` | Ops 统计页 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/core/types.ts` | ChatProvider 增加 `lastUsage?()` |
| `src/providers/openai-compat.ts` | chat/chatCompletion 记录 lastUsage |
| `src/providers/anthropic.ts` | 同上 |
| `test/integration/helpers.ts` | MockProvider 增加 usage/lastUsage |
| `src/core/loop.ts` | turn/llm/tool/job/goal 事件埋点 |
| `src/core/harness.ts` | 构造器第 13 参 tracer；runTurn setSid；runScheduledTurn cron 事件 |
| `src/security/approval.ts` | makePermissionHook 增加 tracer/source 参数，6 条决策路径埋点 |
| `src/compaction/compactor.ts` | CompactorOptions 增加 tracer；主动/反应压缩埋点 |
| `src/memory/system.ts` `recall.ts` `extract.ts` | tracer 透传；recall/extract 埋点 |
| `src/agents/subagent.ts` | spawn/result 埋点 |
| `src/workflow/tools.ts` | workflow start/ok/error 埋点 |
| `src/cli/buildHarness.ts` | 创建 Tracer 并注入各处；opts 增加 approvalSource |
| `src/cli/web.ts` | buildHarnessForWeb 传 approvalSource；startWebServerFromCli 挂 trace module |
| `apps/web-server/src/types.ts` | 增加 TraceModule 接口 |
| `apps/web-server/src/http.ts` | 导出 json；WebContext 增加 trace；挂载 /api/trace/* 路由 |
| `apps/web-server/src/index.ts` | WebServerOptions 增加 trace；导出 TraceModule 类型 |
| `packages/web-client/src/api.ts` | 导出 request |
| `packages/web-client/src/index.ts` | 导出 traceApi 与镜像类型 |
| `apps/web/src/App.tsx` | hash 路由 |
| `apps/web/src/components/SessionSidebar.tsx` | 观测页导航 |
| `apps/web/src/styles.css` | observe-* 样式 |
| `test/core/loop.test.ts` | makeHarness 支持 tracer；新增 tracing describe |
| `test/providers/openai.test.ts` `anthropic.test.ts` | lastUsage 用例 |
| `test/security/approval.test.ts` | approval 事件用例 |
| `test/compaction/compactor.test.ts` | compact 事件用例 |

---

## Task 1: pricing —— 价格表与账本聚合

**Files:**
- Create: `src/tracing/types.ts`
- Create: `src/tracing/pricing.ts`
- Test: `test/tracing/pricing.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/tracing/pricing.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { costFor, usageSummary } from "../../src/tracing/pricing.js";

describe("costFor", () => {
  it("命中已知模型（大小写不敏感）", () => {
    expect(costFor("deepseek-chat", 1_000_000, 1_000_000)).toBeCloseTo(0.27 + 1.1, 6);
    expect(costFor("DeepSeek-Chat", 1_000_000, 0)).toBeCloseTo(0.27, 6);
  });

  it("长模式名优先（deepseek-reasoner 不被 deepseek-chat 抢先命中）", () => {
    expect(costFor("deepseek-reasoner", 1_000_000, 1_000_000)).toBeCloseTo(0.55 + 2.19, 6);
  });

  it("未知模型返回 null", () => {
    expect(costFor("mystery-model", 100, 100)).toBeNull();
  });
});

describe("usageSummary", () => {
  function writeLedger(lines: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-pricing-"));
    const blh = path.join(dir, ".blh");
    fs.mkdirSync(blh, { recursive: true });
    fs.writeFileSync(
      path.join(blh, "usage.jsonl"),
      lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    );
    return dir;
  }

  it("账本不存在时返回空聚合", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-pricing-"));
    const s = usageSummary(dir);
    expect(s.total).toEqual({ in: 0, out: 0, costUsd: 0 });
    expect(s.byDay).toEqual({});
    expect(s.byProvider).toEqual({});
    expect(s.byModel).toEqual({});
  });

  it("聚合 total/byDay/byProvider/byModel 并计算成本，坏行跳过", () => {
    const dir = writeLedger([
      { ts: Date.parse("2026-09-27T10:00:00"), sid: "a", provider: "deepseek", model: "deepseek-chat", in: 1000, out: 2000 },
      { ts: Date.parse("2026-09-27T11:00:00"), sid: "a", provider: "deepseek", model: "deepseek-chat", in: 500, out: 500 },
      { ts: Date.parse("2026-09-26T09:00:00"), sid: "b", provider: "unknown", model: "mystery", in: 100, out: 100 },
      "{bad json",
    ]);
    const s = usageSummary(dir);
    expect(s.total.in).toBe(1600);
    expect(s.total.out).toBe(2600);
    // deepseek-chat: 1500*0.27/1M + 2500*1.10/1M = 0.000405 + 0.00275
    expect(s.total.costUsd).toBeCloseTo(0.000405 + 0.00275, 9);
    const day = Object.keys(s.byDay).sort();
    expect(day.length).toBe(2);
    expect(s.byModel["deepseek-chat"].in).toBe(1500);
    expect(s.byModel["mystery"].costUsd).toBe(0);
    expect(s.byProvider["unknown"].in).toBe(100);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/tracing/pricing.test.ts`
Expected: FAIL，报错 `Cannot find module '../../src/tracing/pricing.js'`（或类似 resolve 错误）。

- [ ] **Step 3: 写最少实现**

创建 `src/tracing/types.ts`：

```ts
export interface TraceEvent {
  ts: number;
  type: string;
  sid: string;
  turn: number;
  [key: string]: unknown;
}

export interface UsageRecord {
  ts: number;
  sid: string;
  provider: string;
  model: string;
  in: number;
  out: number;
}
```

创建 `src/tracing/pricing.ts`：

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageRecord } from "./types.js";

/** USD per 1M tokens: [input, output]。长模式名在前，includes 匹配时优先命中。 */
const MODEL_PRICES: Array<[pattern: string, input: number, output: number]> = [
  ["deepseek-reasoner", 0.55, 2.19],
  ["deepseek-chat", 0.27, 1.1],
  ["qwen-turbo", 0.05, 0.2],
  ["qwen-plus", 0.4, 1.2],
  ["qwen-max", 1.6, 6.4],
  ["moonshot", 0.6, 2.5],
  ["kimi", 0.6, 2.5],
  ["claude-opus", 15, 75],
  ["claude-sonnet", 3, 15],
  ["claude-haiku", 0.8, 4],
];

export function costFor(model: string, inTokens: number, outTokens: number): number | null {
  const m = model.toLowerCase();
  for (const [pattern, i, o] of MODEL_PRICES) {
    if (m.includes(pattern)) {
      return (inTokens * i + outTokens * o) / 1_000_000;
    }
  }
  return null;
}

export interface UsageBucket {
  in: number;
  out: number;
  costUsd: number;
}

export interface UsageSummary {
  total: UsageBucket;
  byDay: Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyBucket(): UsageBucket {
  return { in: 0, out: 0, costUsd: 0 };
}

function add(bucket: UsageBucket, rec: UsageRecord): void {
  bucket.in += rec.in;
  bucket.out += rec.out;
  bucket.costUsd += costFor(rec.model, rec.in, rec.out) ?? 0;
}

export function usageSummary(workdir: string): UsageSummary {
  const summary: UsageSummary = {
    total: emptyBucket(),
    byDay: {},
    byProvider: {},
    byModel: {},
  };
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(workdir, ".blh", "usage.jsonl"), "utf-8").split("\n");
  } catch {
    return summary;
  }
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as UsageRecord;
      add(summary.total, rec);
      add((summary.byDay[dayOf(rec.ts)] ??= emptyBucket()), rec);
      add((summary.byProvider[rec.provider] ??= emptyBucket()), rec);
      add((summary.byModel[rec.model] ??= emptyBucket()), rec);
    } catch {
      // 坏行跳过
    }
  }
  return summary;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/tracing/pricing.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: Commit**

```powershell
git add src/tracing/types.ts src/tracing/pricing.ts test/tracing/pricing.test.ts
git commit -m "feat(tracing): add pricing table and usage ledger aggregation"
```

---

## Task 2: Tracer —— 事件写入与 turn 聚合

**Files:**
- Create: `src/tracing/tracer.ts`
- Test: `test/tracing/tracer.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/tracing/tracer.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Tracer, localDate, summarize } from "../../src/tracing/tracer.js";

function makeTracer(): { tracer: Tracer; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-tracer-"));
  return { tracer: new Tracer(dir), dir };
}

function readDay(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, ".blh", "traces", `${localDate()}.jsonl`);
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readLedger(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, ".blh", "usage.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("summarize", () => {
  it("短文本原样返回", () => {
    expect(summarize("hello")).toBe("hello");
  });

  it("超长截断并加省略号", () => {
    const out = summarize("x".repeat(600));
    expect(out.length).toBe(501);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("Tracer", () => {
  it("事件带统一信封，turn 边界聚合正确", () => {
    const { tracer, dir } = makeTracer();
    tracer.setSid("sess-1");
    tracer.beginTurn("帮我修个 bug");
    tracer.event("llm", { provider: "deepseek", model: "deepseek-chat", stream: true, status: "ok", latency_ms: 100 });
    tracer.event("llm", { provider: "deepseek", model: "deepseek-chat", stream: true, status: "ok", latency_ms: 80, usage: { promptTokens: 10, completionTokens: 5 } });
    tracer.event("tool", { tool: "bash", args_summary: "ls", latency_ms: 20, status: "ok", output_summary: "…" });
    tracer.endTurn();

    const events = readDay(dir);
    expect(events.map((e) => e["type"])).toEqual(["turn_start", "llm", "llm", "tool", "turn_end"]);
    for (const e of events) {
      expect(e["sid"]).toBe("sess-1");
      expect(e["turn"]).toBe(1);
      expect(typeof e["ts"]).toBe("number");
    }
    expect(events[0]["user_message"]).toBe("帮我修个 bug");
    const end = events[4];
    expect(end["iterations"]).toBe(2);
    expect(end["tools_used"]).toBe(1);
    expect(typeof end["latency_ms"]).toBe("number");
    expect(end["cost_usd"]).toBeCloseTo((10 * 0.27 + 5 * 1.1) / 1_000_000, 12);
  });

  it("usage 账本只记录带 usage 的 llm 事件", () => {
    const { tracer, dir } = makeTracer();
    tracer.beginTurn("hi");
    tracer.event("llm", { provider: "deepseek", model: "deepseek-chat", status: "ok", latency_ms: 10 });
    tracer.event("llm", { provider: "deepseek", model: "deepseek-chat", status: "ok", latency_ms: 10, usage: { promptTokens: 3, completionTokens: 4 } });
    tracer.event("tool", { tool: "read", args_summary: "a", latency_ms: 1, status: "ok", output_summary: "b" });
    tracer.endTurn();

    const ledger = readLedger(dir);
    expect(ledger.length).toBe(1);
    expect(ledger[0]).toMatchObject({ provider: "deepseek", model: "deepseek-chat", in: 3, out: 4 });
  });

  it("cancelTurn 记录取消原因", () => {
    const { tracer, dir } = makeTracer();
    tracer.beginTurn("long task");
    tracer.event("llm", { provider: "deepseek", model: "m", status: "ok", latency_ms: 5 });
    tracer.cancelTurn("aborted");
    const events = readDay(dir);
    expect(events[2]["type"]).toBe("turn_cancelled");
    expect(events[2]["reason"]).toBe("aborted");
    expect(events[2]["iterations"]).toBe(1);
  });

  it("turn 计数自增", () => {
    const { tracer, dir } = makeTracer();
    tracer.beginTurn("one");
    tracer.endTurn();
    tracer.beginTurn("two");
    tracer.endTurn();
    const events = readDay(dir);
    expect(events[0]["turn"]).toBe(1);
    expect(events[2]["turn"]).toBe(2);
  });

  it("写入失败静默（.blh 路径被文件占用时不抛异常）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-tracer-"));
    fs.writeFileSync(path.join(dir, ".blh"), "not a dir");
    const tracer = new Tracer(dir);
    expect(() => {
      tracer.beginTurn("x");
      tracer.event("llm", { provider: "p", model: "m", status: "ok", latency_ms: 1, usage: { promptTokens: 1, completionTokens: 1 } });
      tracer.endTurn();
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/tracing/tracer.test.ts`
Expected: FAIL，`Cannot find module '../../src/tracing/tracer.js'`。

- [ ] **Step 3: 写最少实现**

创建 `src/tracing/tracer.ts`：

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@blh/logger";
import type { ChatUsage } from "../core/types.js";
import { costFor } from "./pricing.js";
import type { UsageRecord } from "./types.js";

const log = createLogger("tracer");

/** 截断长文本，保护事件体积。 */
export function summarize(text: string, max = 500): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export function localDate(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface LlmPayload {
  provider: string;
  model: string;
  status: string;
  latency_ms: number;
  usage?: ChatUsage | null;
  [key: string]: unknown;
}

/**
 * 追加式 JSONL tracer。所有 I/O 失败静默（warn 一次），绝不打断主流程。
 */
export class Tracer {
  private sid = "cli";
  private turn = 0;
  private turnStart = 0;
  private iterations = 0;
  private toolsUsed = 0;
  private costUsd = 0;
  private warned = false;

  constructor(private readonly workdir: string) {}

  static tracesDir(workdir: string): string {
    return path.join(workdir, ".blh", "traces");
  }

  setSid(sid: string): void {
    this.sid = sid;
  }

  beginTurn(userMessage: string): void {
    this.turn += 1;
    this.turnStart = Date.now();
    this.iterations = 0;
    this.toolsUsed = 0;
    this.costUsd = 0;
    this.event("turn_start", { user_message: summarize(userMessage) });
  }

  endTurn(): void {
    this.event("turn_end", this.turnStats());
  }

  cancelTurn(reason: string): void {
    this.event("turn_cancelled", { ...this.turnStats(), reason });
  }

  private turnStats(): Record<string, unknown> {
    return {
      latency_ms: Date.now() - this.turnStart,
      iterations: this.iterations,
      tools_used: this.toolsUsed,
      cost_usd: this.costUsd,
    };
  }

  event(type: string, payload: Record<string, unknown>): void {
    try {
      if (type === "llm") {
        this.iterations += 1;
        this.recordUsage(payload as unknown as LlmPayload);
      } else if (type === "tool") {
        this.toolsUsed += 1;
      }
      this.writeLine(this.dayFile(), JSON.stringify({ ts: Date.now(), type, sid: this.sid, turn: this.turn, ...payload }) + "\n");
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private recordUsage(p: LlmPayload): void {
    if (p.usage == null) return;
    const cost = costFor(p.model, p.usage.promptTokens, p.usage.completionTokens);
    if (cost !== null) this.costUsd += cost;
    const rec: UsageRecord = {
      ts: Date.now(),
      sid: this.sid,
      provider: p.provider,
      model: p.model,
      in: p.usage.promptTokens,
      out: p.usage.completionTokens,
    };
    this.writeLine(path.join(this.workdir, ".blh", "usage.jsonl"), JSON.stringify(rec) + "\n");
  }

  private dayFile(): string {
    return path.join(Tracer.tracesDir(this.workdir), `${localDate()}.jsonl`);
  }

  private writeLine(file: string, line: string): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    log.warn("tracing disabled after write failure", { error: String(err) });
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/tracing/tracer.test.ts`
Expected: PASS（7 passed）

- [ ] **Step 5: Commit**

```powershell
git add src/tracing/tracer.ts test/tracing/tracer.test.ts
git commit -m "feat(tracing): add Tracer with JSONL event log and usage ledger"
```

---

## Task 3: fold —— 事件折叠为 Turn 视图

**Files:**
- Create: `src/tracing/fold.ts`
- Test: `test/tracing/fold.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/tracing/fold.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldEvents, readTraceFile } from "../../src/tracing/fold.js";
import type { TraceEvent } from "../../src/tracing/types.js";

function ev(partial: Partial<TraceEvent> & { type: string }): TraceEvent {
  return { ts: 1000, sid: "s1", turn: 1, ...partial };
}

describe("foldEvents", () => {
  it("按 sid#turn 分组并保序", () => {
    const turns = foldEvents([
      ev({ type: "turn_start", user_message: "one" }),
      ev({ type: "llm" }),
      ev({ type: "turn_end", latency_ms: 50, iterations: 1, tools_used: 0, cost_usd: 0 }),
      ev({ type: "turn_start", turn: 2, user_message: "two" }),
      ev({ type: "turn_end", turn: 2, latency_ms: 30, iterations: 0, tools_used: 0, cost_usd: 0 }),
    ]);
    expect(turns.length).toBe(2);
    expect(turns[0].userMessage).toBe("one");
    expect(turns[1].userMessage).toBe("two");
    expect(turns[0].events.map((e) => e.type)).toEqual(["turn_start", "llm", "turn_end"]);
  });

  it("turn_end 闭合 turn 并取聚合字段", () => {
    const turns = foldEvents([
      ev({ type: "turn_start", user_message: "hi" }),
      ev({ type: "turn_end", latency_ms: 120, iterations: 2, tools_used: 1, cost_usd: 0.001 }),
    ]);
    expect(turns[0].finished).toBe(true);
    expect(turns[0].cancelled).toBe(false);
    expect(turns[0].latencyMs).toBe(120);
    expect(turns[0].iterations).toBe(2);
    expect(turns[0].toolsUsed).toBe(1);
    expect(turns[0].costUsd).toBe(0.001);
  });

  it("turn_cancelled 标记取消；未闭合 turn finished=false", () => {
    const cancelled = foldEvents([
      ev({ type: "turn_start", user_message: "x" }),
      ev({ type: "turn_cancelled", latency_ms: 10, iterations: 1, tools_used: 0, cost_usd: 0, reason: "aborted" }),
    ]);
    expect(cancelled[0].cancelled).toBe(true);
    expect(cancelled[0].finished).toBe(true);

    const open = foldEvents([ev({ type: "turn_start", user_message: "y" })]);
    expect(open[0].finished).toBe(false);
  });
});

describe("readTraceFile", () => {
  it("读取 JSONL 并跳过坏行", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-fold-"));
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, JSON.stringify(ev({ type: "turn_start" })) + "\n{bad\n" + JSON.stringify(ev({ type: "turn_end" })) + "\n");
    const events = readTraceFile(file);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("turn_start");
    expect(events[1].type).toBe("turn_end");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/tracing/fold.test.ts`
Expected: FAIL，`Cannot find module '../../src/tracing/fold.js'`。

- [ ] **Step 3: 写最少实现**

创建 `src/tracing/fold.ts`：

```ts
import * as fs from "node:fs";
import type { TraceEvent } from "./types.js";

export interface FoldedTurn {
  turn: number;
  sid: string;
  userMessage: string;
  startedAt: number;
  finished: boolean;
  cancelled: boolean;
  latencyMs: number | null;
  iterations: number;
  toolsUsed: number;
  costUsd: number;
  events: TraceEvent[];
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** 把事件流折叠为 turn 视图（按 sid#turn 分组，保持文件内顺序）。 */
export function foldEvents(events: TraceEvent[]): FoldedTurn[] {
  const turns = new Map<string, FoldedTurn>();
  for (const e of events) {
    const key = `${e.sid}#${e.turn}`;
    let t = turns.get(key);
    if (t === undefined) {
      t = {
        turn: e.turn,
        sid: e.sid,
        userMessage: "",
        startedAt: e.ts,
        finished: false,
        cancelled: false,
        latencyMs: null,
        iterations: 0,
        toolsUsed: 0,
        costUsd: 0,
        events: [],
      };
      turns.set(key, t);
    }
    t.events.push(e);
    if (e.type === "turn_start") {
      t.userMessage = typeof e["user_message"] === "string" ? e["user_message"] : "";
      t.startedAt = e.ts;
    } else if (e.type === "turn_end" || e.type === "turn_cancelled") {
      t.finished = true;
      t.cancelled = e.type === "turn_cancelled";
      t.latencyMs = num(e["latency_ms"]);
      t.iterations = num(e["iterations"]);
      t.toolsUsed = num(e["tools_used"]);
      t.costUsd = num(e["cost_usd"]);
    }
  }
  return [...turns.values()];
}

export function readTraceFile(file: string): TraceEvent[] {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // 坏行跳过
    }
  }
  return events;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/tracing/fold.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```powershell
git add src/tracing/fold.ts test/tracing/fold.test.ts
git commit -m "feat(tracing): add event folding into turn view"
```

---

## Task 4: module —— TraceModule 查询实现

**Files:**
- Create: `src/tracing/module.ts`
- Test: `test/tracing/module.test.ts`

> 说明：`TraceModule` 接口由 web-server 定义（任务 13），此处按结构类型实现同一形状（TS 结构类型兼容，根包不依赖 web-server）。

- [ ] **Step 1: 写失败测试**

创建 `test/tracing/module.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTraceModule } from "../../src/tracing/module.js";
import { localDate } from "../../src/tracing/tracer.js";

function setup(traceLines: string[], ledgerLines: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
  const traces = path.join(dir, ".blh", "traces");
  fs.mkdirSync(traces, { recursive: true });
  if (traceLines.length > 0) {
    fs.writeFileSync(path.join(traces, `${localDate()}.jsonl`), traceLines.join("\n") + "\n");
  }
  if (ledgerLines.length > 0) {
    fs.writeFileSync(path.join(dir, ".blh", "usage.jsonl"), ledgerLines.join("\n") + "\n");
  }
  return dir;
}

const TURN_EVENTS = [
  JSON.stringify({ ts: 1000, type: "turn_start", sid: "s1", turn: 1, user_message: "hi" }),
  JSON.stringify({ ts: 1100, type: "llm", sid: "s1", turn: 1, provider: "deepseek", model: "deepseek-chat", status: "ok", latency_ms: 50 }),
  JSON.stringify({ ts: 1200, type: "tool", sid: "s1", turn: 1, tool: "bash", args_summary: "ls", latency_ms: 10, status: "ok", output_summary: "x" }),
  JSON.stringify({ ts: 1300, type: "turn_end", sid: "s1", turn: 1, latency_ms: 300, iterations: 1, tools_used: 1, cost_usd: 0.001 }),
];

describe("files", () => {
  it("列出 trace 日期文件（倒序，过滤非法文件名）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const traces = path.join(dir, ".blh", "traces");
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(path.join(traces, "2026-09-27.jsonl"), "");
    fs.writeFileSync(path.join(traces, "2026-09-26.jsonl"), "");
    fs.writeFileSync(path.join(traces, "notes.txt"), "");
    const m = createTraceModule(dir) as { files(): string[] };
    expect(m.files()).toEqual(["2026-09-27", "2026-09-26"]);
  });

  it("目录不存在返回空数组", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const m = createTraceModule(dir) as { files(): string[] };
    expect(m.files()).toEqual([]);
  });
});

describe("events 游标语义", () => {
  it("cursor=0 返回全部事件与 nextCursor", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: unknown[]; nextCursor: number } };
    const r = m.events(0);
    expect(r.events.length).toBe(4);
    expect(r.nextCursor).toBe(4);
  });

  it("cursor 增量拉取", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: Array<{ type: string }>; nextCursor: number } };
    const r = m.events(2);
    expect(r.events.map((e) => e.type)).toEqual(["tool", "turn_end"]);
    expect(r.nextCursor).toBe(4);
  });

  it("cursor 越界归位（返回空 + 当前 total）", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: unknown[]; nextCursor: number } };
    const r = m.events(99);
    expect(r.events).toEqual([]);
    expect(r.nextCursor).toBe(4);
  });

  it("指定历史日期读取对应文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const traces = path.join(dir, ".blh", "traces");
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(path.join(traces, "2026-09-26.jsonl"), TURN_EVENTS[0] + "\n");
    const m = createTraceModule(dir) as { events(c: number, d?: string): { events: unknown[]; nextCursor: number } };
    const r = m.events(0, "2026-09-26");
    expect(r.events.length).toBe(1);
    expect(r.nextCursor).toBe(1);
  });
});

describe("turns", () => {
  it("折叠当日事件并按时间倒序返回", () => {
    const second = TURN_EVENTS.map((l) =>
      l.replace('"turn":1', '"turn":2').replace('"user_message":"hi"', '"user_message":"second"'),
    );
    const dir = setup([...TURN_EVENTS, ...second]);
    const m = createTraceModule(dir) as { turns(o?: { limit?: number }): Array<{ userMessage: string; toolsUsed: number }> };
    const turns = m.turns();
    expect(turns.length).toBe(2);
    expect(turns[0].userMessage).toBe("second");
    expect(turns[1].toolsUsed).toBe(1);
  });

  it("limit 生效", () => {
    const dir = setup(TURN_EVENTS);
    const m = createTraceModule(dir) as { turns(o?: { limit?: number }): unknown[] };
    expect(m.turns({ limit: 1 }).length).toBe(1);
  });
});

describe("overview", () => {
  it("聚合账本与当日 turn 统计", () => {
    const dir = setup(TURN_EVENTS, [
      JSON.stringify({ ts: 1250, sid: "s1", provider: "deepseek", model: "deepseek-chat", in: 100, out: 50 }),
    ]);
    const m = createTraceModule(dir) as {
      overview(): {
        usage: { total: { in: number } };
        today: { turns: number; tools: number; avgLatencyMs: number };
        recentTurns: Array<{ userMessage: string }>;
      };
    };
    const o = m.overview();
    expect(o.usage.total.in).toBe(100);
    expect(o.today.turns).toBe(1);
    expect(o.today.tools).toBe(1);
    expect(o.today.avgLatencyMs).toBe(300);
    expect(o.recentTurns[0].userMessage).toBe("hi");
  });

  it("空目录返回零值", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blh-module-"));
    const m = createTraceModule(dir) as {
      overview(): { today: { turns: number; tools: number; avgLatencyMs: number }; recentTurns: unknown[] };
    };
    const o = m.overview();
    expect(o.today).toEqual({ turns: 0, tools: 0, avgLatencyMs: 0 });
    expect(o.recentTurns).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/tracing/module.test.ts`
Expected: FAIL，`Cannot find module '../../src/tracing/module.js'`。

- [ ] **Step 3: 写最少实现**

创建 `src/tracing/module.ts`：

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { foldEvents, readTraceFile, type FoldedTurn } from "./fold.js";
import { usageSummary, type UsageSummary } from "./pricing.js";
import { Tracer, localDate } from "./tracer.js";
import type { TraceEvent } from "./types.js";

export interface TraceOverview {
  usage: UsageSummary;
  today: { turns: number; tools: number; avgLatencyMs: number };
  recentTurns: FoldedTurn[];
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function listDates(workdir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(Tracer.tracesDir(workdir));
  } catch {
    return [];
  }
  return names
    .map((n) => FILE_RE.exec(n)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort()
    .reverse();
}

function readDay(workdir: string, date: string): TraceEvent[] {
  return readTraceFile(path.join(Tracer.tracesDir(workdir), `${date}.jsonl`));
}

export function createTraceModule(workdir: string): unknown {
  return {
    overview(): TraceOverview {
      const events = readDay(workdir, localDate());
      const finished = foldEvents(events).filter((t) => t.finished);
      const tools = finished.reduce((n, t) => n + t.toolsUsed, 0);
      const latencies = finished.map((t) => t.latencyMs ?? 0);
      const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
      return {
        usage: usageSummary(workdir),
        today: { turns: finished.length, tools, avgLatencyMs },
        recentTurns: finished.slice(-5).reverse(),
      };
    },

    turns(opts?: { date?: string; sid?: string; limit?: number }): FoldedTurn[] {
      const date = opts?.date ?? localDate();
      let turns = foldEvents(readDay(workdir, date));
      if (opts?.sid !== undefined && opts.sid !== "") {
        turns = turns.filter((t) => t.sid === opts.sid);
      }
      return turns.slice(-(opts?.limit ?? 50)).reverse();
    },

    events(cursor: number, date?: string): { events: TraceEvent[]; nextCursor: number } {
      const file = path.join(Tracer.tracesDir(workdir), `${date ?? localDate()}.jsonl`);
      let content: string;
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        return { events: [], nextCursor: 0 };
      }
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      const total = lines.length;
      if (cursor >= total) {
        return { events: [], nextCursor: total };
      }
      const events: TraceEvent[] = [];
      for (const line of lines.slice(Math.max(0, cursor))) {
        try {
          events.push(JSON.parse(line) as TraceEvent);
        } catch {
          // 坏行跳过
        }
      }
      return { events, nextCursor: total };
    },

    files(): string[] {
      return listDates(workdir);
    },
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/tracing/module.test.ts`
Expected: PASS（9 passed）

- [ ] **Step 5: Commit**

```powershell
git add src/tracing/module.ts test/tracing/module.test.ts
git commit -m "feat(tracing): add TraceModule query implementation"
```

---

## Task 5: ChatProvider.lastUsage —— 非流式路径的 usage 采集

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/providers/openai-compat.ts`
- Modify: `src/providers/anthropic.ts`
- Modify: `test/integration/helpers.ts`
- Test: `test/providers/openai.test.ts`
- Test: `test/providers/anthropic.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/providers/openai.test.ts` 末尾追加：

```ts
describe("lastUsage", () => {
  it("chat() 后返回最近一次 usage；chatCompletion() 覆盖更新", async () => {
    const create = async () => ({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
    const provider = new OpenAICompatProvider(config, makeClient(create as never) as never);
    expect(provider.lastUsage()).toBeUndefined();
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(provider.lastUsage()).toEqual({ promptTokens: 11, completionTokens: 7 });

    const create2 = async () => ({
      choices: [{ message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    const provider2 = new OpenAICompatProvider(config, makeClient(create2 as never) as never);
    await provider2.chatCompletion?.([{ role: "user", content: "hi" }], "sys");
    expect(provider2.lastUsage()).toEqual({ promptTokens: 3, completionTokens: 2 });
  });

  it("usage 缺失时 lastUsage 保持 undefined", async () => {
    const create = async () => ({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });
    const provider = new OpenAICompatProvider(config, makeClient(create as never) as never);
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(provider.lastUsage()).toBeUndefined();
  });
});
```

在 `test/providers/anthropic.test.ts` 末尾追加：

```ts
describe("lastUsage", () => {
  it("chat() 后返回最近一次 usage", async () => {
    const create = async () => ({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const provider = new AnthropicProvider(config, { messages: { create } } as never);
    expect(provider.lastUsage()).toBeUndefined();
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(provider.lastUsage()).toEqual({ promptTokens: 10, completionTokens: 2 });
  });
});
```

> 注意：追加测试时沿用各文件顶部已有的 `config` / `makeClient` / import；若现有 mock 形状与上述不同，以文件内现有用例为准对齐。anthropic 的 `chatCompletion` 用例可参照现有同文件测试补充。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/providers/openai.test.ts test/providers/anthropic.test.ts`
Expected: FAIL，`provider.lastUsage is not a function`。

- [ ] **Step 3: 写最少实现**

`src/core/types.ts` —— 在 `ChatProvider` 接口（L86-91）的 `chatCompletion?` 之后追加成员：

```ts
  /** 最近一次 chat()/chatCompletion() 的 token 用量（非流式路径记账用）；未实现或未调用时返回 undefined。 */
  lastUsage?(): ChatUsage | undefined;
```

`src/providers/openai-compat.ts` —— 三处改动：

1. 类字段区（构造函数附近）加：

```ts
  private last: ChatUsage | undefined;
```

2. `chat()` 在拿到 `response` 后、构造返回值前加：

```ts
    if (response.usage) {
      this.last = { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens };
    }
```

3. `chatCompletion()` 同样位置加相同记录逻辑；类末尾加方法：

```ts
  lastUsage(): ChatUsage | undefined {
    return this.last;
  }
```

（确认文件顶部 `import type { ... } from "../core/types.js"` 已含 `ChatUsage`，没有则补上。）

`src/providers/anthropic.ts` —— 同构改动，字段映射为：

```ts
    if (response.usage) {
      this.last = { promptTokens: response.usage.input_tokens, completionTokens: response.usage.output_tokens };
    }
```

`test/integration/helpers.ts` —— MockProvider 增加：

```ts
  usage: ChatUsage | undefined = { promptTokens: 10, completionTokens: 5 };

  lastUsage(): ChatUsage | undefined {
    return this.usage;
  }
```

（确认 import 含 `ChatUsage` 类型，from `../../src/core/types.js`。）

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/providers/openai.test.ts test/providers/anthropic.test.ts test/integration`
Expected: PASS（新增用例全过，既有用例不回归）

- [ ] **Step 5: typecheck 并 Commit**

Run: `pnpm typecheck`
Expected: 无错误。

```powershell
git add src/core/types.ts src/providers/openai-compat.ts src/providers/anthropic.ts test/integration/helpers.ts test/providers/openai.test.ts test/providers/anthropic.test.ts
git commit -m "feat(providers): record lastUsage for non-streaming usage accounting"
```

---

## Task 6: loop.ts 埋点 —— turn/llm/tool/job/goal 事件

**Files:**
- Modify: `src/core/loop.ts`
- Test: `test/core/loop.test.ts`

> 这是全计划最核心的埋点任务。所有 SearchReplace 锚点均来自 loop.ts 当前原文，逐段按原文替换。

- [ ] **Step 1: 写失败测试**

`test/core/loop.test.ts` 顶部 import 区追加：

```ts
import { Tracer, localDate } from "../../src/tracing/tracer.js";
```

文件末尾追加新 describe（复用文件内已有的 `makeHarness` / `MockProvider` / `makeToolCallMessage` / `makeTextMessage` / `sequentialEvaluator` / `GoalController` / `config`；`fs/os/path` 已 import）：

```ts
describe("agentLoop tracing", () => {
  function makeTracer(): { tracer: Tracer; dir: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-loop-trace-"));
    return { tracer: new Tracer(dir), dir };
  }

  function readTrace(dir: string): Array<Record<string, unknown>> {
    const file = path.join(dir, ".blh", "traces", `${localDate()}.jsonl`);
    if (!existsSync(file)) return [];
    return require("node:fs")
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l: string) => l.trim() !== "")
      .map((l: string) => JSON.parse(l) as Record<string, unknown>);
  }

  function readLedgerCount(dir: string): number {
    const file = path.join(dir, ".blh", "usage.jsonl");
    if (!existsSync(file)) return 0;
    return require("node:fs")
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l: string) => l.trim() !== "").length;
  }

  it("完整一轮：事件序列 turn_start/llm/tool/llm/turn_end，账本记 2 行", async () => {
    const { tracer, dir } = makeTracer();
    const harness = makeHarness(
      [makeToolCallMessage("echo", { text: "hi" }), makeTextMessage("done")],
      { tracer },
    );
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(harness, messages, "go");

    const events = readTrace(dir);
    expect(events.map((e) => e["type"])).toEqual(["turn_start", "llm", "tool", "llm", "turn_end"]);
    expect(events[0]["user_message"]).toBe("go");
    const llm = events[1];
    expect(llm["provider"]).toBeDefined();
    expect(llm["status"]).toBe("ok");
    expect(typeof llm["latency_ms"]).toBe("number");
    const tool = events[2];
    expect(tool["tool"]).toBe("echo");
    expect(tool["status"]).toBe("ok");
    expect(typeof tool["args_summary"]).toBe("string");
    const end = events[4];
    expect(end["iterations"]).toBe(2);
    expect(end["tools_used"]).toBe(1);
    // MockProvider usage {10,5} × 2 次 llm 调用
    expect(readLedgerCount(dir)).toBe(2);
  });

  it("goal block 决策产生 goal 事件", async () => {
    const { tracer, dir } = makeTracer();
    const goal = new GoalController(
      sequentialEvaluator([
        { ok: false, reason: "not yet", impossible: false },
        { ok: true, reason: "done", impossible: false },
      ]),
    );
    goal.setGoal("finish");
    const harness = makeHarness([makeTextMessage("try1"), makeTextMessage("done")], { goal, tracer });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");

    const goalEvents = readTrace(dir).filter((e) => e["type"] === "goal");
    expect(goalEvents.length).toBe(1);
    expect(goalEvents[0]["action"]).toBe("block");
    expect(goalEvents[0]["reason"]).toBe("not yet");
  });

  it("runTurn 设置 sid 为会话文件名", async () => {
    const { tracer, dir } = makeTracer();
    const harness = makeHarness([makeTextMessage("done")], { tracer });
    const storeDir = mkdtempSync(path.join(os.tmpdir(), "blh-loop-store-"));
    harness.sessionStore = SessionStore.create(storeDir);
    const messages = harness.newSession();
    await harness.runTurn(messages, "go");

    const events = readTrace(dir);
    expect(events.length).toBeGreaterThan(0);
    expect(String(events[0]["sid"])).toMatch(/\.jsonl$/);
  });

  it("runScheduledTurn 记录 cron job fired 事件", async () => {
    const { tracer, dir } = makeTracer();
    const jobs = {
      injectBackgroundResults: () => 0,
      consumeAndInjectCron: () => [{ id: "job-1" }],
      cron: { acknowledge: () => {}, restore: () => {} },
      background: { hasRunning: () => false },
    } as unknown as JobsRuntime;
    const harness = makeHarness([makeTextMessage("done")], { jobs, tracer });
    await harness.runScheduledTurn([]);

    const jobEvents = readTrace(dir).filter((e) => e["type"] === "job");
    expect(jobEvents.length).toBe(1);
    expect(jobEvents[0]).toMatchObject({ kind: "cron", name: "job-1", status: "fired" });
  });

  it("工具批次后 abort 产生 turn_cancelled 事件", async () => {
    const { tracer, dir } = makeTracer();
    const controller = new AbortController();
    const hooks = new HookBus();
    hooks.register(PRE_TOOL_USE, async () => {
      controller.abort();
      return null;
    });
    const harness = makeHarness(
      [makeToolCallMessage("echo", { text: "hi" }), makeTextMessage("done")],
      { hooks, tracer },
    );
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(harness, messages, "go", undefined, controller.signal);

    const events = readTrace(dir);
    const last = events[events.length - 1]!;
    expect(last["type"]).toBe("turn_cancelled");
  });
});
```

> 说明：若 `require` 在 ESM 测试环境不可用，改为在文件顶部 `import { readFileSync } from "node:fs"`（L2 已有 node:fs 的 named import，直接加 `readFileSync` 即可），测试体内用 `readFileSync(file, "utf-8")`。优先采用改顶部 import 的方式。

同时修改 `makeHarness`：options 类型加 `tracer?: Tracer;`，构造调用末尾（`options.goal,` 之后）补两位：

```ts
    options.goal,
    undefined,
    options.tracer,
  );
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/core/loop.test.ts`
Expected: FAIL——makeHarness 类型报错或 `harness.tracer` 为 undefined 导致事件文件不存在、断言全败；同时既有 cron/jobs 相关用例不受影响。

- [ ] **Step 3: 写最少实现（loop.ts 逐段修改）**

**3a. import（L1 与 L9 后）：**

L1 替换：

```ts
import type { ChatMessage, ChatProvider, ChatUsage, ToolCall, ToolDefinition } from "./types.js";
```

L9 后新增一行：

```ts
import { summarize } from "../tracing/tracer.js";
```

**3b. turn_start 埋点（L76 后）：**

old:

```ts
  await events?.emit({ type: "turn_start" });
  // 一个死循环，靠内部的 return 来退出（模型不再调用工具且目标达成时退出）。
```

new:

```ts
  await events?.emit({ type: "turn_start" });
  harness.tracer?.beginTurn(activeRequest);
  // 一个死循环，靠内部的 return 来退出（模型不再调用工具且目标达成时退出）。
```

**3c. 循环开头 abort 点（L79-83）：**

old:

```ts
    if (signal?.aborted) {
      markLastAssistantCancelled(messages);
      await events?.emit({ type: "turn_cancelled", text: "" });
      return;
    }
    log.debug("turn start", { messages: messages.length });
```

new:

```ts
    if (signal?.aborted) {
      markLastAssistantCancelled(messages);
      harness.tracer?.cancelTurn("aborted");
      await events?.emit({ type: "turn_cancelled", text: "" });
      return;
    }
    log.debug("turn start", { messages: messages.length });
```

**3d. 后台结果注入（L94-97）：**

old:

```ts
    // 如果配置了后台任务管理器，把已经跑完的后台任务结果注入到对话里，让模型能看到进展。
    if (harness.jobs) {
      harness.jobs.injectBackgroundResults(messages);
    }
```

new:

```ts
    // 如果配置了后台任务管理器，把已经跑完的后台任务结果注入到对话里，让模型能看到进展。
    if (harness.jobs) {
      const injected = harness.jobs.injectBackgroundResults(messages);
      if (injected > 0) {
        harness.tracer?.event("job", { kind: "background", name: "collect", status: "completed", count: injected });
      }
    }
```

**3e. LLM 调用区（L98-120）：**

old:

```ts
    let message: ChatMessage;
    // 判断能不能用「流式输出」：既要传了事件总线，也要 provider 本身支持 stream。
    // 流式输出 = 模型一个字一个字地吐，前端能实时看到；非流式 = 等整段回复生成完再一次性返回。
    const streamAvailable = events !== undefined && harness.provider.stream !== undefined;
    try {
      if (streamAvailable) {
        // 走流式输出，边生成边把文字增量广播出去。
        try {
          message = await streamAssistantMessage(harness.provider, messages, harness.tools.list(), events, signal);
        } catch (error) {
          if (error instanceof TurnCancelledError) throw error;
          // 流式偶尔会失败，这里退回到非流式方式再试一次，保证对话不中断。
          log.warn("stream failed, falling back to non-streaming", {
            error: error instanceof Error ? error.message : String(error),
          });
          message = await harness.provider.chat(messages, harness.tools.list(), undefined, signal);
        }
      } else {
        // 不支持流式就直接用普通方式调用模型。
        message = await harness.provider.chat(messages, harness.tools.list(), undefined, signal);
      }
      // 这轮成功拿到模型回复了，说明「提示词过长」的问题（如果之前有过）已经解决，重置重试计数。
      reactiveRetries = 0;
    } catch (error) {
```

new:

```ts
    let message: ChatMessage;
    // 判断能不能用「流式输出」：既要传了事件总线，也要 provider 本身支持 stream。
    // 流式输出 = 模型一个字一个字地吐，前端能实时看到；非流式 = 等整段回复生成完再一次性返回。
    const streamAvailable = events !== undefined && harness.provider.stream !== undefined;
    let usage: ChatUsage | null = null;
    let usedStream = false;
    const llmStart = Date.now();
    try {
      if (streamAvailable) {
        // 走流式输出，边生成边把文字增量广播出去。
        try {
          const streamed = await streamAssistantMessage(harness.provider, messages, harness.tools.list(), events, signal);
          message = streamed.message;
          usage = streamed.usage;
          usedStream = true;
        } catch (error) {
          if (error instanceof TurnCancelledError) throw error;
          // 流式偶尔会失败，这里退回到非流式方式再试一次，保证对话不中断。
          log.warn("stream failed, falling back to non-streaming", {
            error: error instanceof Error ? error.message : String(error),
          });
          harness.tracer?.event("llm", {
            provider: harness.config.provider ?? "deepseek",
            model: harness.config.model,
            stream: true,
            status: "error",
            latency_ms: Date.now() - llmStart,
            retries: reactiveRetries,
            usage: null,
          });
          message = await harness.provider.chat(messages, harness.tools.list(), undefined, signal);
          usage = harness.provider.lastUsage?.() ?? null;
        }
      } else {
        // 不支持流式就直接用普通方式调用模型。
        message = await harness.provider.chat(messages, harness.tools.list(), undefined, signal);
        usage = harness.provider.lastUsage?.() ?? null;
      }
      harness.tracer?.event("llm", {
        provider: harness.config.provider ?? "deepseek",
        model: harness.config.model,
        stream: usedStream,
        status: "ok",
        stop_reason: message.tool_calls !== undefined && message.tool_calls.length > 0 ? "tool_calls" : "stop",
        latency_ms: Date.now() - llmStart,
        retries: reactiveRetries,
        usage,
      });
      // 这轮成功拿到模型回复了，说明「提示词过长」的问题（如果之前有过）已经解决，重置重试计数。
      reactiveRetries = 0;
    } catch (error) {
```

（注意：llm 成功事件必须在 `reactiveRetries = 0` 之前记录，保证 retries 值真实。）

**3f. TurnCancelledError 与 catch 内 abort（L122-135）：**

old:

```ts
      if (error instanceof TurnCancelledError) {
        const partial: ChatMessage = { role: "assistant", content: error.partialText, cancelled: true };
        messages.push(partial);
        harness.sessionStore?.append(partial);
        await events?.emit({ type: "turn_cancelled", text: error.partialText });
        return;
      }
      if (signal?.aborted) {
        const partial: ChatMessage = { role: "assistant", content: "", cancelled: true };
        messages.push(partial);
        harness.sessionStore?.append(partial);
        await events?.emit({ type: "turn_cancelled", text: "" });
        return;
      }
```

new:

```ts
      if (error instanceof TurnCancelledError) {
        const partial: ChatMessage = { role: "assistant", content: error.partialText, cancelled: true };
        messages.push(partial);
        harness.sessionStore?.append(partial);
        harness.tracer?.cancelTurn("cancelled");
        await events?.emit({ type: "turn_cancelled", text: error.partialText });
        return;
      }
      if (signal?.aborted) {
        const partial: ChatMessage = { role: "assistant", content: "", cancelled: true };
        messages.push(partial);
        harness.sessionStore?.append(partial);
        harness.tracer?.cancelTurn("aborted");
        await events?.emit({ type: "turn_cancelled", text: "" });
        return;
      }
```

**3g. goal 事件与 turn_end（L155-166）：**

old:

```ts
    if (toolCalls.length === 0) {
      const decision = await evaluateGoalStop(harness, messages);
      // decision.action === "block" 表示「目标还没达成，不许结束」。
      // 这时拼一条提醒消息塞回对话，让模型继续干活，然后重新进入下一轮。
      if (decision !== null && decision.action === "block") {
        const reminder: ChatMessage = { role: "user", content: goalReminder(harness.goal, decision) };
        messages.push(reminder);
        harness.sessionStore?.append(reminder);
        continue;
      }
      // 目标已达成（或根本没有设置目标），广播「这一轮结束」并退出整个循环。
      await events?.emit({ type: "turn_end" });
      return;
    }
```

new:

```ts
    if (toolCalls.length === 0) {
      const decision = await evaluateGoalStop(harness, messages);
      if (decision !== null && decision.action !== "allow") {
        harness.tracer?.event("goal", { action: decision.action, reason: summarize(decision.reason) });
      }
      // decision.action === "block" 表示「目标还没达成，不许结束」。
      // 这时拼一条提醒消息塞回对话，让模型继续干活，然后重新进入下一轮。
      if (decision !== null && decision.action === "block") {
        const reminder: ChatMessage = { role: "user", content: goalReminder(harness.goal, decision) };
        messages.push(reminder);
        harness.sessionStore?.append(reminder);
        continue;
      }
      // 目标已达成（或根本没有设置目标），广播「这一轮结束」并退出整个循环。
      harness.tracer?.endTurn();
      await events?.emit({ type: "turn_end" });
      return;
    }
```

（若 `StopDecision.reason` 为可选，改为 `summarize(decision.reason ?? "")`。）

**3h. 工具循环（L175-234）：**

old:

```ts
    for (const call of toolCalls) {
      const name = call.function.name;
      log.debug("tool call", { tool: name });
      // 把模型传过来的 JSON 字符串参数解析成对象（比如 '{"command":"ls"}' -> {command:"ls"}）。
      const input = parseToolArguments(call.function.arguments);
      // 广播「开始调用工具」的事件。
      await events?.emit({ type: "tool_call", id: call.id, name, arguments: call.function.arguments });
      let result: string;
      if (compactor && name === "compact") {
```

new:

```ts
    for (const call of toolCalls) {
      const name = call.function.name;
      const toolStart = Date.now();
      log.debug("tool call", { tool: name });
      // 把模型传过来的 JSON 字符串参数解析成对象（比如 '{"command":"ls"}' -> {command:"ls"}）。
      const input = parseToolArguments(call.function.arguments);
      const background = harness.jobs !== undefined && name === "bash" && input["run_in_background"] === true;
      // 广播「开始调用工具」的事件。
      await events?.emit({ type: "tool_call", id: call.id, name, arguments: call.function.arguments });
      let result: string;
      if (compactor && name === "compact") {
```

old:

```ts
      } else if (
        harness.jobs !== undefined &&
        name === "bash" &&
        input["run_in_background"] === true
      ) {
```

new:

```ts
      } else if (background) {
```

old:

```ts
            // 把命令交给后台任务管理器启动，立刻返回（不等待命令跑完）。
            result = harness.jobs.startBackground(String(input["command"] ?? ""));
```

new:

```ts
            // 把命令交给后台任务管理器启动，立刻返回（不等待命令跑完）。
            result = harness.jobs.startBackground(String(input["command"] ?? ""));
            harness.tracer?.event("job", { kind: "background", name: summarize(String(input["command"] ?? ""), 100), status: "started" });
```

old:

```ts
      // 广播「工具执行完毕」的事件，同时根据结果开头判断这次是不是出错了（error: 或 denied 开头算错误）。
      await events?.emit({
        type: "tool_result",
        id: call.id,
        name,
        output: result,
        isError: result.startsWith("error:") || result.startsWith("denied"),
      });
```

new:

```ts
      // 广播「工具执行完毕」的事件，同时根据结果开头判断这次是不是出错了（error: 或 denied 开头算错误）。
      await events?.emit({
        type: "tool_result",
        id: call.id,
        name,
        output: result,
        isError: result.startsWith("error:") || result.startsWith("denied"),
      });
      harness.tracer?.event("tool", {
        tool: name,
        args_summary: summarize(JSON.stringify(input)),
        latency_ms: Date.now() - toolStart,
        status: result.startsWith("error:") ? "error" : result.startsWith("denied") ? "denied" : "ok",
        output_summary: summarize(result),
        ...(background ? { background: true } : {}),
      });
```

**3i. 工具批次后 abort（L236-240）：**

old:

```ts
    if (signal?.aborted) {
      markLastAssistantCancelled(messages);
      await events?.emit({ type: "turn_cancelled", text: "" });
      return;
    }

    // 如果配置了待办管理器，并且本轮调用过 todo_write，就把「待办进度提醒」拼到最后一条工具结果上。
```

new:

```ts
    if (signal?.aborted) {
      markLastAssistantCancelled(messages);
      harness.tracer?.cancelTurn("aborted");
      await events?.emit({ type: "turn_cancelled", text: "" });
      return;
    }

    // 如果配置了待办管理器，并且本轮调用过 todo_write，就把「待办进度提醒」拼到最后一条工具结果上。
```

**3j. streamAssistantMessage 返回 usage（L284-308）：**

old:

```ts
/** 消费 Provider 底层流，转发文本增量，返回拼好的最终消息。 */
async function streamAssistantMessage(
  provider: ChatProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  events: EventBus,
  signal?: AbortSignal,
): Promise<ChatMessage> {
  const stream = provider.stream!(messages, tools, undefined, signal);
  let partialText = "";
  try {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        partialText += event.text;
        await events.emit({ type: "assistant_text_delta", text: event.text });
      } else if (event.type === "done") {
        return event.message;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new TurnCancelledError(partialText);
    throw error;
  }
  throw new Error("provider stream ended without a done event");
}
```

new:

```ts
/** 消费 Provider 底层流，转发文本增量，返回拼好的最终消息与 token 用量。 */
async function streamAssistantMessage(
  provider: ChatProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  events: EventBus,
  signal?: AbortSignal,
): Promise<{ message: ChatMessage; usage: ChatUsage | null }> {
  const stream = provider.stream!(messages, tools, undefined, signal);
  let partialText = "";
  try {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        partialText += event.text;
        await events.emit({ type: "assistant_text_delta", text: event.text });
      } else if (event.type === "done") {
        return { message: event.message, usage: event.usage ?? null };
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new TurnCancelledError(partialText);
    throw error;
  }
  throw new Error("provider stream ended without a done event");
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/core/loop.test.ts`
Expected: PASS（新增 5 个 tracing 用例 + 既有用例全部通过；`harness.tracer` 在任务 7 才加入 Harness，本步会因 `harness.tracer` 不存在而报 TS 错——**先执行任务 7 Step 3 的 Harness 字段声明，再回来跑本步**；或临时把 loop.ts 中 `harness.tracer` 视为 `any`。推荐：任务 6 与任务 7 的实现步合并执行，测试步分开核对。）

- [ ] **Step 5: Commit**

```powershell
git add src/core/loop.ts test/core/loop.test.ts src/core/harness.ts
git commit -m "feat(core): instrument agent loop with turn/llm/tool/job/goal trace events"
```

---

## Task 7: Harness 装配 tracer（第 13 参 + setSid + cron 事件）

**Files:**
- Modify: `src/core/harness.ts`
- Test: 复用 `test/core/loop.test.ts`（Task 6 已写 runTurn setSid 与 cron job 事件用例）

> 说明：Task 6 的测试在本任务实现前因 `Harness` 无 `tracer` 字段而编译失败——这正是本任务的「失败测试」起点。

- [ ] **Step 1: 运行 Task 6 测试确认失败**

Run: `pnpm vitest run test/core/loop.test.ts`
Expected: FAIL（TS 报错：`Property 'tracer' does not exist on type 'Harness'`）

- [ ] **Step 2: 修改 harness.ts（四段替换）**

2a. import 区（文件顶部 L13-14）：

```typescript
// old
import { CLEAR_ALIASES, type GoalController } from "../goals/controller.js";
import type { SessionStore } from "../session/store.js";

// new
import { CLEAR_ALIASES, type GoalController } from "../goals/controller.js";
import type { SessionStore } from "../session/store.js";
import * as path from "node:path";
import type { Tracer } from "../tracing/tracer.js";
```

2b. 构造函数加第 13 个参数（L41-43）：

```typescript
// old
    readonly goal?: GoalController,
    readonly workflow?: string,
  ) {

// new
    readonly goal?: GoalController,
    readonly workflow?: string,
    readonly tracer?: Tracer,
  ) {
```

2c. runTurn 开头设置会话 sid（L85-86）：

```typescript
// old
    await this.hooks.trigger(USER_PROMPT_SUBMIT, { text });
    const userMessage: ChatMessage = { role: "user", content: text };

// new
    this.tracer?.setSid(this.sessionStore ? path.basename(this.sessionStore.path) : "cli");
    await this.hooks.trigger(USER_PROMPT_SUBMIT, { text });
    const userMessage: ChatMessage = { role: "user", content: text };
```

2d. runScheduledTurn 记录 cron 触发事件（L105-107）：

```typescript
// old
    const fired = jobs.consumeAndInjectCron(messages);
    if (fired.length === 0) return;
    try {

// new
    const fired = jobs.consumeAndInjectCron(messages);
    if (fired.length === 0) return;
    for (const job of fired) {
      this.tracer?.event("job", { kind: "cron", name: job.id, status: "fired" });
    }
    try {
```

（`CronJob.id` 已存在于 `src/jobs/cron.ts` L98-99，无需新增。）

- [ ] **Step 3: 运行测试验证通过**

Run: `pnpm vitest run test/core/loop.test.ts`
Expected: PASS（Task 6 全部用例通过）

- [ ] **Step 4: Commit**（若与 Task 6 实现合并执行则并入同一 commit，此处不重复提交）

```powershell
git add src/core/harness.ts
git commit -m "feat(core): wire tracer into Harness (setSid + cron job events)"
```

---

## Task 8: 审批链路 trace（approval.ts）

**Files:**
- Modify: `src/security/approval.ts`
- Test: `test/security/approval.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/security/approval.test.ts` 顶部 import 区追加：

```typescript
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Tracer } from "../../src/tracing/tracer.js";
```

在文件末尾追加：

```typescript
describe("makePermissionHook（trace 事件）", () => {
  function readTraceEvents(workdir: string): Array<Record<string, unknown>> {
    const dir = path.join(workdir, ".blh", "traces");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );
  }

  it("用户拒绝时记录 deny/user 事件（source=web）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const hook = makePermissionHook(DEFAULT_RULES, async () => "deny", undefined, tracer, "web");
    expect(await hook("bash", { command: "ls" })).toBe("denied by user");
    const events = readTraceEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "deny",
      rule: "user",
      source: "web",
    });
  });

  it("规则放行时记录 allow/matched_rule 事件（默认 source=cli）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const rules: PermissionRule[] = [{ tool: "bash", target: "ls", action: "allow" }];
    const hook = makePermissionHook(rules, async () => "deny", undefined, tracer);
    expect(await hook("bash", { command: "ls" })).toBeNull();
    expect(readTraceEvents(dir)[0]).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "allow",
      rule: "matched_rule",
      source: "cli",
    });
  });

  it("always_allow 记录 allow/new_rule 事件", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blh-trace-approval-"));
    const tracer = new Tracer(dir);
    const hook = makePermissionHook([...DEFAULT_RULES], async () => "always_allow", undefined, tracer);
    expect(await hook("bash", { command: "ls -la" })).toBeNull();
    expect(readTraceEvents(dir)[0]).toMatchObject({
      type: "approval",
      tool: "bash",
      decision: "allow",
      rule: "new_rule",
      source: "cli",
    });
  });

  it("不传 tracer 时行为不变（向后兼容）", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "allow");
    expect(await hook("bash", { command: "ls" })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/security/approval.test.ts`
Expected: FAIL（`makePermissionHook` 不接受第 4、5 参数）

- [ ] **Step 3: 修改 approval.ts（七段替换）**

3a. import 区（L4 后）：

```typescript
// old
import { createLogger } from "@blh/logger";

// new
import { createLogger } from "@blh/logger";
import type { Tracer } from "../tracing/tracer.js";
```

3b. 函数签名（L32-36）：

```typescript
// old
export function makePermissionHook(
  rules: PermissionRule[],
  ask?: ApprovalAsker,
  persistRule?: (rule: PermissionRule) => void,
): PermissionHook {

// new
export function makePermissionHook(
  rules: PermissionRule[],
  ask?: ApprovalAsker,
  persistRule?: (rule: PermissionRule) => void,
  tracer?: Tracer,
  source: "cli" | "web" = "cli",
): PermissionHook {
```

3c. 破坏性命令硬拦（L45-48）：

```typescript
// old
    if (tool === "bash" && isDestructiveBashCommand(target)) {
      log.warn("denied by rule (destructive)", { tool, target });
      return `denied by permission rule (${tool}: ${target})`;
    }

// new
    if (tool === "bash" && isDestructiveBashCommand(target)) {
      log.warn("denied by rule (destructive)", { tool, target });
      tracer?.event("approval", { tool, decision: "deny", rule: "destructive_bash", source });
      return `denied by permission rule (${tool}: ${target})`;
    }
```

3d. 规则放行（L50）：

```typescript
// old
    if (action === "allow") return null;

// new
    if (action === "allow") {
      tracer?.event("approval", { tool, decision: "allow", rule: "matched_rule", source });
      return null;
    }
```

3e. 规则拒绝（L51-54）：

```typescript
// old
    if (action === "deny") {
      log.warn("denied by rule", { tool, target });
      return `denied by permission rule (${tool}: ${target})`;
    }

// new
    if (action === "deny") {
      log.warn("denied by rule", { tool, target });
      tracer?.event("approval", { tool, decision: "deny", rule: "matched_rule", source });
      return `denied by permission rule (${tool}: ${target})`;
    }
```

3f. scheduled turn 拒绝（L55-57）：

```typescript
// old
    if (scheduledTurnStorage.getStore() === true) {
      return "denied: cannot request approval from a scheduled turn";
    }

// new
    if (scheduledTurnStorage.getStore() === true) {
      tracer?.event("approval", { tool, decision: "deny", rule: "scheduled_turn", source });
      return "denied: cannot request approval from a scheduled turn";
    }
```

3g. 用户拒绝与放行/new_rule（L59-74）：

```typescript
// old
    if (decision === "deny") {
      if (!hasAsker) {
        return "denied: no approval asker available (non-interactive mode); use --dangerously-skip-permissions to allow non-destructive bash";
      }
      log.warn("denied by user", { tool, target });
      return "denied by user";
    }
    if (decision === "always_allow" && target !== "") {

// new
    if (decision === "deny") {
      tracer?.event("approval", { tool, decision: "deny", rule: hasAsker ? "user" : "no_asker", source });
      if (!hasAsker) {
        return "denied: no approval asker available (non-interactive mode); use --dangerously-skip-permissions to allow non-destructive bash";
      }
      log.warn("denied by user", { tool, target });
      return "denied by user";
    }
    tracer?.event("approval", {
      tool,
      decision: "allow",
      rule: decision === "always_allow" && target !== "" ? "new_rule" : "user",
      source,
    });
    if (decision === "always_allow" && target !== "") {
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/security/approval.test.ts`
Expected: PASS（新增 4 例 + 既有 12 例全部通过）

- [ ] **Step 5: Commit**

```powershell
git add src/security/approval.ts test/security/approval.test.ts
git commit -m "feat(security): record approval decisions to trace"
```

---

## Task 9: 压缩事件 trace（compactor.ts）

**Files:**
- Modify: `src/compaction/compactor.ts`
- Test: `test/compaction/compactor.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/compaction/compactor.test.ts` 文件末尾追加（import 区已有 `mkdtempSync/readdirSync/readFileSync/os/path`，另需 `import { Tracer } from "../../src/tracing/tracer.js";`）：

```typescript
describe("ContextCompactor（trace 事件）", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "compactor-trace-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readTraceEvents(workdir: string): Array<Record<string, unknown>> {
    const dir = path.join(workdir, ".blh", "traces");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );
  }

  it("compactHistory 记录 proactive 事件", async () => {
    const provider = new FakeProvider([textMsg("摘要内容")]);
    const tracer = new Tracer(tmpDir);
    const compactor = new ContextCompactor({
      provider,
      toolResultsDir: path.join(tmpDir, ".task_outputs", "tool-results"),
      tracer,
    });
    const messages = [userMsg("a"), textMsg("b"), userMsg("c")];
    const result = await compactor.compactHistory(messages, "req");
    expect(result).toHaveLength(1);
    expect(readTraceEvents(tmpDir)).toEqual([
      expect.objectContaining({ type: "compact", kind: "proactive", before_msgs: 3, after_msgs: 1 }),
    ]);
  });

  it("reactiveCompact 记录 reactive 事件（after_msgs 为实际结果条数）", async () => {
    const provider = new FakeProvider([textMsg("摘要内容")]);
    const tracer = new Tracer(tmpDir);
    const compactor = new ContextCompactor({
      provider,
      toolResultsDir: path.join(tmpDir, ".task_outputs", "tool-results"),
      tracer,
    });
    const messages = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? userMsg(`u${i}`) : textMsg(`a${i}`),
    );
    const result = await compactor.reactiveCompact(messages, "req");
    expect(readTraceEvents(tmpDir)).toEqual([
      expect.objectContaining({
        type: "compact",
        kind: "reactive",
        before_msgs: 8,
        after_msgs: result.length,
      }),
    ]);
  });
});
```

> 注：`tmpDir` 在本 describe 内自建（既有 describe 的 `tmpDir` 是块级局部变量，不可复用）；`textMsg`/`userMsg`/`FakeProvider` 复用文件顶部既有 helper。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/compaction/compactor.test.ts`
Expected: FAIL（`CompactorOptions` 无 `tracer` 字段，TS 报错）

- [ ] **Step 3: 修改 compactor.ts（五段替换）**

3a. import 区（L4 后）：

```typescript
// old
import { createLogger } from "@blh/logger";

// new
import { createLogger } from "@blh/logger";
import type { Tracer } from "../tracing/tracer.js";
```

3b. CompactorOptions（L14-19）：

```typescript
// old
export interface CompactorOptions {
  /** 聊天模型提供者（用来调模型做摘要）。 */
  provider: ChatProvider;
  /** 工具结果落盘的目录。 */
  toolResultsDir: string;
}

// new
export interface CompactorOptions {
  /** 聊天模型提供者（用来调模型做摘要）。 */
  provider: ChatProvider;
  /** 工具结果落盘的目录。 */
  toolResultsDir: string;
  /** 可选 tracer：记录压缩事件。 */
  tracer?: Tracer;
}
```

3c. 类字段与构造函数（L35-45）：

```typescript
// old
  readonly provider: ChatProvider;
  readonly toolResultsDir: string;

  /** 实例级上下文阈值，默认取静态常量；测试可覆写（TS 实例无法遮蔽 static）。 */
  contextCharLimit: number = ContextCompactor.CONTEXT_CHAR_LIMIT;

  /** 创建一个压缩器，记下 provider（调模型做摘要用）和工具结果落盘的目录。 */
  constructor(options: CompactorOptions) {
    this.provider = options.provider;
    this.toolResultsDir = options.toolResultsDir;
  }

// new
  readonly provider: ChatProvider;
  readonly toolResultsDir: string;
  readonly tracer?: Tracer;

  /** 实例级上下文阈值，默认取静态常量；测试可覆写（TS 实例无法遮蔽 static）。 */
  contextCharLimit: number = ContextCompactor.CONTEXT_CHAR_LIMIT;

  /** 创建一个压缩器，记下 provider（调模型做摘要用）和工具结果落盘的目录。 */
  constructor(options: CompactorOptions) {
    this.provider = options.provider;
    this.toolResultsDir = options.toolResultsDir;
    this.tracer = options.tracer;
  }
```

3d. compactHistory（L396-399）：

```typescript
// old
  async compactHistory(messages: ChatMessage[], activeRequest: string): Promise<ChatMessage[]> {
    const summary = await this.summarizeHistory(messages);
    return [ContextCompactor.summaryMessage("已压缩", activeRequest, summary)];
  }

// new
  async compactHistory(messages: ChatMessage[], activeRequest: string): Promise<ChatMessage[]> {
    const summary = await this.summarizeHistory(messages);
    this.tracer?.event("compact", { kind: "proactive", before_msgs: messages.length, after_msgs: 1 });
    return [ContextCompactor.summaryMessage("已压缩", activeRequest, summary)];
  }
```

3e. reactiveCompact 结尾（L436-437）：

```typescript
// old
    // 摘要放最前，尾部最近几条原样保留。
    return tailStart ? [message, ...messages.slice(tailStart)] : [message];

// new
    // 摘要放最前，尾部最近几条原样保留。
    const result = tailStart ? [message, ...messages.slice(tailStart)] : [message];
    this.tracer?.event("compact", { kind: "reactive", before_msgs: messages.length, after_msgs: result.length });
    return result;
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/compaction/compactor.test.ts`
Expected: PASS（新增 2 例 + 既有用例全部通过）

- [ ] **Step 5: Commit**

```powershell
git add src/compaction/compactor.ts test/compaction/compactor.test.ts
git commit -m "feat(compaction): record proactive/reactive compact events to trace"
```

---

## Task 10: 记忆系统 trace（recall / extract / system 透传）

**Files:**
- Modify: `src/memory/system.ts`、`src/memory/recall.ts`、`src/memory/extract.ts`
- Test: `test/memory/recall.test.ts`、`test/memory/extract.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/memory/recall.test.ts` import 区追加 `import { readdirSync, readFileSync } from "node:fs";` 和 `import { Tracer } from "../../src/tracing/tracer.js";`，文件末尾追加：

```typescript
describe("MemoryRecall（trace 事件）", () => {
  it("loadMemories 记录 recall 事件（hits 为选中条数）", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    store.writeMemoryFile("Pref", "user", "use tabs", "indent with tabs");
    const tracer = new Tracer(tmpDir);
    const recall = new MemoryRecall(
      store,
      new MockProvider([{ role: "assistant", content: "[0]" }]),
      tracer,
    );
    const out = await recall.loadMemories([{ role: "user", content: "what indentation?" }]);
    expect(out).not.toBe("");
    const dir = path.join(tmpDir, ".blh", "traces");
    const events = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      );
    expect(events).toEqual([expect.objectContaining({ type: "memory", action: "recall", hits: 1 })]);
  });
});
```

在 `test/memory/extract.test.ts` import 区追加同样的两个 import，文件末尾追加：

```typescript
describe("MemoryExtractor（trace 事件）", () => {
  it("extractMemories 记录 extract 事件（new_facts 为写入条数）", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    const tracer = new Tracer(tmpDir);
    const extractor = new MemoryExtractor(
      store,
      new MockProvider([{
        role: "assistant",
        content: JSON.stringify([
          { name: "Pref", type: "user", scope: "persistent", description: "Likes tabs", body: "Use tabs." },
        ]),
      }]),
      tracer,
    );
    const stored = await extractor.extractMemories([
      { role: "user", content: "I prefer tabs" },
      { role: "assistant", content: "noted" },
    ]);
    expect(stored).toBe(1);
    const dir = path.join(tmpDir, ".blh", "traces");
    const events = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      );
    expect(events).toEqual([expect.objectContaining({ type: "memory", action: "extract", new_facts: 1 })]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/memory/recall.test.ts test/memory/extract.test.ts`
Expected: FAIL（`MemoryRecall`/`MemoryExtractor` 构造函数不接受第 3 参数）

- [ ] **Step 3: 实现（三个文件）**

3a. `src/memory/recall.ts` — import 区（L3 后）加 `import type { Tracer } from "../tracing/tracer.js";`；构造函数：

```typescript
// old
  constructor(
    private readonly store: MemoryStore,
    private readonly provider: ChatProvider,
  ) {}

// new
  constructor(
    private readonly store: MemoryStore,
    private readonly provider: ChatProvider,
    private readonly tracer?: Tracer,
  ) {}
```

loadMemories 结尾（L157）：

```typescript
// old
    return loaded.length ? JSON.stringify(loaded, null, 2) : "";

// new
    this.tracer?.event("memory", { action: "recall", hits: loaded.length });
    return loaded.length ? JSON.stringify(loaded, null, 2) : "";
```

3b. `src/memory/extract.ts` — import 区加 `import type { Tracer } from "../tracing/tracer.js";`；构造函数（L37-40）：

```typescript
// old
  constructor(
    readonly store: MemoryStore,
    private readonly provider: ChatProvider,
  ) {}

// new
  constructor(
    readonly store: MemoryStore,
    private readonly provider: ChatProvider,
    private readonly tracer?: Tracer,
  ) {}
```

extractMemories 成功返回前（L152-155）：

```typescript
// old
      if (stored) {
        log.info("stored records", { stored });
      }
      return stored;

// new
      if (stored) {
        log.info("stored records", { stored });
      }
      this.tracer?.event("memory", { action: "extract", new_facts: stored });
      return stored;
```

3c. `src/memory/system.ts` — import 区加 `import type { Tracer } from "../tracing/tracer.js";`；构造函数（L21-27）：

```typescript
// old
  constructor(
    readonly store: MemoryStore,
    readonly provider: ChatProvider,
  ) {
    this.recall = new MemoryRecall(store, provider);
    this.extractor = new MemoryExtractor(store, provider);
  }

// new
  constructor(
    readonly store: MemoryStore,
    readonly provider: ChatProvider,
    readonly tracer?: Tracer,
  ) {
    this.recall = new MemoryRecall(store, provider, tracer);
    this.extractor = new MemoryExtractor(store, provider, tracer);
  }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/memory/`
Expected: PASS（新增 2 例 + 既有用例全部通过）

- [ ] **Step 5: Commit**

```powershell
git add src/memory/system.ts src/memory/recall.ts src/memory/extract.ts test/memory/recall.test.ts test/memory/extract.test.ts
git commit -m "feat(memory): record recall/extract events to trace"
```

---

## Task 11: 子代理与工作流 trace

**Files:**
- Modify: `src/agents/subagent.ts`、`src/workflow/tools.ts`
- Test: `test/agents/subagent.test.ts`、`test/workflow/tools.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/agents/subagent.test.ts` import 区追加 `import { readdirSync } from "node:fs";`（`readFileSync` 已存在）和 `import { Tracer } from "../../src/tracing/tracer.js";`，在 `describe("SubagentRunner", ...)` 内追加：

```typescript
  it("records spawn/result trace events", async () => {
    const tracer = new Tracer(tmpDir);
    const runner = new SubagentRunner(new MockProvider([makeTextMessage("done")]), config, new HookBus(), tracer);
    await runner.run("do it");
    const dir = path.join(tmpDir, ".blh", "traces");
    const events = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      );
    expect(events[0]).toMatchObject({ type: "subagent", status: "spawn", task: "do it" });
    expect(events[1]).toMatchObject({ type: "subagent", status: "result" });
    expect(typeof events[1]?.["latency_ms"]).toBe("number");
  });
```

在 `test/workflow/tools.test.ts` import 区追加 `readdirSync, readFileSync`（合并进既有 node:fs import）、`import { Tracer } from "../../src/tracing/tracer.js";`，describe 内追加：

```typescript
  it("records workflow trace events (ok and error)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wf-trace-"));
    try {
      const tracer = new Tracer(dir);
      const registry = new ToolRegistry();
      registerWorkflowTools(registry, path.join(dir, ".workflow_runtime"), () => new MockWorkflowRunner(), WORKFLOWS, tracer);
      await registry.dispatch("run_workflow", { name: "review-changes", args: { changes: "x = 1" } });
      await registry.dispatch("run_workflow", { name: "no-such-workflow" });
      const tracesDir = path.join(dir, ".blh", "traces");
      const events = readdirSync(tracesDir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) =>
          readFileSync(path.join(tracesDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
        );
      expect(events[0]).toMatchObject({ type: "workflow", workflow: "review-changes", status: "start" });
      expect(events[1]).toMatchObject({ type: "workflow", workflow: "review-changes", status: "ok" });
      expect(events[2]).toMatchObject({ type: "workflow", workflow: "no-such-workflow", status: "start" });
      expect(events[3]).toMatchObject({ type: "workflow", workflow: "no-such-workflow", status: "error" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run test/agents/subagent.test.ts test/workflow/tools.test.ts`
Expected: FAIL（`SubagentRunner` 不接受第 4 参数；`registerWorkflowTools` 不接受第 5 参数）

- [ ] **Step 3: 实现**

3a. `src/agents/subagent.ts` — import 区（L6 后）加：

```typescript
import { summarize, type Tracer } from "../tracing/tracer.js";
```

构造函数（L20-24）：

```typescript
// old
  constructor(
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
  ) {

// new
  constructor(
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
    readonly tracer?: Tracer,
  ) {
```

run 开头（L33-34）：

```typescript
// old
  async run(prompt: string): Promise<string> {
    const messages: ChatMessage[] = [

// new
  async run(prompt: string): Promise<string> {
    const start = Date.now();
    this.tracer?.event("subagent", { name: "subagent", status: "spawn", task: summarize(prompt, 200) });
    const messages: ChatMessage[] = [
```

最终回答返回点（L42-44）：

```typescript
// old
      if (toolCalls.length === 0) {
        return assistant.content || "(no summary)";
      }

// new
      if (toolCalls.length === 0) {
        this.tracer?.event("subagent", { name: "subagent", status: "result", latency_ms: Date.now() - start });
        return assistant.content || "(no summary)";
      }
```

30 轮兜底返回点（L59）：

```typescript
// old
    return "Subagent stopped after 30 turns without a final answer.";

// new
    this.tracer?.event("subagent", { name: "subagent", status: "result", latency_ms: Date.now() - start });
    return "Subagent stopped after 30 turns without a final answer.";
```

3b. `src/workflow/tools.ts` — import 区（L5 后）加 `import type { Tracer } from "../tracing/tracer.js";`；签名（L7-12）：

```typescript
// old
export function registerWorkflowTools(
  registry: ToolRegistry,
  store: string,
  runnerFactory: () => WorkflowRunner,
  workflows: WorkflowRegistry,
): void {

// new
export function registerWorkflowTools(
  registry: ToolRegistry,
  store: string,
  runnerFactory: () => WorkflowRunner,
  workflows: WorkflowRegistry,
  tracer?: Tracer,
): void {
```

handler（L25-39）：

```typescript
// old
    handler: async (a) => {
      try {
        const name = typeof a.name === "string" ? a.name : "";
        const args =
          typeof a.args === "object" && a.args !== null && !Array.isArray(a.args)
            ? (a.args as Record<string, unknown>)
            : undefined;
        const resume = typeof a.resume_from_run_id === "string" ? a.resume_from_run_id : undefined;
        const result = await runWorkflow(name, args, resume, store, runnerFactory, workflows);
        return JSON.stringify(result);
      } catch (error) {
        if (error instanceof WorkflowInputError) return `Error: ${error.message}`;
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },

// new
    handler: async (a) => {
      const name = typeof a.name === "string" ? a.name : "";
      const start = Date.now();
      tracer?.event("workflow", { workflow: name, stage: "run", status: "start" });
      try {
        const args =
          typeof a.args === "object" && a.args !== null && !Array.isArray(a.args)
            ? (a.args as Record<string, unknown>)
            : undefined;
        const resume = typeof a.resume_from_run_id === "string" ? a.resume_from_run_id : undefined;
        const result = await runWorkflow(name, args, resume, store, runnerFactory, workflows);
        tracer?.event("workflow", { workflow: name, stage: "run", status: "ok", latency_ms: Date.now() - start });
        return JSON.stringify(result);
      } catch (error) {
        tracer?.event("workflow", { workflow: name, stage: "run", status: "error", latency_ms: Date.now() - start });
        if (error instanceof WorkflowInputError) return `Error: ${error.message}`;
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run test/agents/subagent.test.ts test/workflow/tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/agents/subagent.ts src/workflow/tools.ts test/agents/subagent.test.ts test/workflow/tools.test.ts
git commit -m "feat(agents,workflow): record subagent/workflow events to trace"
```

---

## Task 12: CLI 装配接线（buildHarness.ts + web.ts approvalSource）

**Files:**
- Modify: `src/cli/buildHarness.ts`、`src/cli/web.ts`

> 本任务只做根包侧接线；`trace:` 注入 web-server 在 Task 13 完成（web-server 先支持 `TraceModule`，否则 typecheck 不过）。

- [ ] **Step 1: 修改 buildHarness.ts（七处）**

1a. import 区（L40 后）加：

```typescript
import { Tracer } from "../tracing/tracer.js";
```

1b. opts 类型（L74-77）：

```typescript
// old
  opts?: {
    userRules?: PermissionRule[];
    persistRule?: (rule: PermissionRule) => void;
  },

// new
  opts?: {
    userRules?: PermissionRule[];
    persistRule?: (rule: PermissionRule) => void;
    approvalSource?: "cli" | "web";
  },
```

1c. initLogger 之后（L82 后）加：

```typescript
  // 创建 tracer：全链路事件落盘到 <workdir>/.blh/traces，失败静默不影响主流程。
  const tracer = new Tracer(config.workdir);
```

1d. makePermissionHook 调用（L103）：

```typescript
// old
  const permissionHook = makePermissionHook(rules, askUser, opts?.persistRule);

// new
  const permissionHook = makePermissionHook(rules, askUser, opts?.persistRule, tracer, opts?.approvalSource ?? "cli");
```

1e. Memory 构造（L118）：

```typescript
// old
  const memory = new Memory(new MemoryStore(path.join(config.workdir, ".memory")), provider);

// new
  const memory = new Memory(new MemoryStore(path.join(config.workdir, ".memory")), provider, tracer);
```

1f. ContextCompactor 构造（L133-136）：

```typescript
// old
  const compactor = new ContextCompactor({
    provider,
    toolResultsDir: path.join(config.workdir, ".task_outputs", "tool-results"),
  });

// new
  const compactor = new ContextCompactor({
    provider,
    toolResultsDir: path.join(config.workdir, ".task_outputs", "tool-results"),
    tracer,
  });
```

1g. SubagentRunner / registerWorkflowTools / Harness（L151、L172、L178）：

```typescript
// old
  const subagent = new SubagentRunner(provider, config, hooks);

// new
  const subagent = new SubagentRunner(provider, config, hooks, tracer);
```

```typescript
// old
  registerWorkflowTools(tools, workflowStore, () => new OpenAIWorkflowRunner(provider), WORKFLOWS);

// new
  registerWorkflowTools(tools, workflowStore, () => new OpenAIWorkflowRunner(provider), WORKFLOWS, tracer);
```

```typescript
// old
  return new Harness(config, provider, tools, hooks, compactor, todoManager, memory, jobs, agents, extensions, goal, workflowStore);

// new
  return new Harness(config, provider, tools, hooks, compactor, todoManager, memory, jobs, agents, extensions, goal, workflowStore, tracer);
```

- [ ] **Step 2: 修改 web.ts（buildHarnessForWeb 注入 approvalSource）**

```typescript
// old
const buildHarnessForWeb: BuildHarness = (deps) =>
  buildHarness(deps.workdir, deps.cli, deps.askUser, deps.skipPermissions, {
    userRules: deps.userRules,
    persistRule: deps.persistRule,
  });

// new
const buildHarnessForWeb: BuildHarness = (deps) =>
  buildHarness(deps.workdir, deps.cli, deps.askUser, deps.skipPermissions, {
    userRules: deps.userRules,
    persistRule: deps.persistRule,
    approvalSource: "web",
  });
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck ; pnpm vitest run test/core/loop.test.ts test/security/approval.test.ts`
Expected: typecheck 通过；测试 PASS（全量回归在 Task 19）

- [ ] **Step 4: Commit**

```powershell
git add src/cli/buildHarness.ts src/cli/web.ts
git commit -m "feat(cli): wire tracer through buildHarness and mark web approval source"
```

---

## Task 13: web-server trace 只读端点

**Files:**
- Create: `apps/web-server/src/trace.ts`
- Modify: `apps/web-server/src/types.ts`、`apps/web-server/src/http.ts`、`apps/web-server/src/index.ts`、`src/cli/web.ts`
- Test: `apps/web-server/test/trace.test.ts`

> 设计说明：`trace.ts` 内置本地 `sendJson`（3 行），**不**从 `http.ts` 导入 `json`——避免 `http.ts ↔ trace.ts` 循环 ESM 导入。游标语义已在根包 `test/tracing/module.test.ts` 覆盖，本测试只验证路由 wiring。

- [ ] **Step 1: 写失败测试 `apps/web-server/test/trace.test.ts`**

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createWebServer, type WebContext } from "../src/http.js";
import { SSEBroadcaster } from "../src/bridge.js";
import { SessionManager } from "../src/session.js";
import { ApprovalCoordinator } from "../src/approval.js";
import type { TraceModule, TurnLock, WebTurnRunner } from "../src/types.js";
import { makeTestSessionStore } from "./helpers.js";

function makeContext(workdir: string, trace?: TraceModule): WebContext {
  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));
  const runner: WebTurnRunner = {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: async () => {},
  };
  const lock: TurnLock = { withLock: async <T,>(fn: () => Promise<T>) => fn() };
  const sessionStore = makeTestSessionStore();
  const session = new SessionManager(runner, lock, (event) => broadcaster.broadcast(event), approvals, sessionStore);
  session.create(workdir);
  return { session, broadcaster, workdir, staticDir: null, sessionStore, ...(trace !== undefined ? { trace } : {}) };
}

async function listen(ctx: WebContext): Promise<{ server: Server; url: string }> {
  const server = createWebServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

const stubTrace: TraceModule = {
  overview: () => ({ totalTurns: 3 }),
  turns: (opts) => ({ turns: [], opts: opts ?? null }),
  events: (cursor, date) => ({ events: [], cursor, nextCursor: cursor, date: date ?? null }),
  files: () => ({ files: ["2026-09-27.jsonl"] }),
};

describe("trace api", () => {
  let tmpDir: string;
  let servers: Server[] = [];
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-trace-"));
  });
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/trace/overview 返回模块数据", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/overview`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ totalTurns: 3 });
  });

  it("未注入 trace 时返回 404", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/overview`);
    expect(res.status).toBe(404);
  });

  it("非 GET 返回 405", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/overview`, { method: "POST", headers: { "x-blh-web": "1" } });
    expect(res.status).toBe(405);
  });

  it("非法 date 返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/turns?date=09-27`);
    expect(res.status).toBe(400);
  });

  it("events 透传 cursor 与 date", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/events?cursor=5&date=2026-09-27`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], cursor: 5, nextCursor: 5, date: "2026-09-27" });
  });

  it("非法 cursor 返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir, stubTrace));
    servers.push(server);
    const res = await fetch(`${url}/api/trace/events?cursor=-1`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @blh/web-server test`
Expected: FAIL（`WebContext` 无 `trace` 字段、`TraceModule` 未导出、`/api/trace/*` 404 以外的行为不存在）

- [ ] **Step 3: 实现**

3a. `apps/web-server/src/types.ts` 文件末尾（`BuildHarness` 之后）追加：

```typescript
/** Trace 读取模块的最小接口（根包 src/tracing/module.ts 的 createTraceModule 满足）。 */
export interface TraceModule {
  overview(): unknown;
  turns(opts?: { date?: string; sid?: string; limit?: number }): unknown;
  events(cursor: number, date?: string): unknown;
  files(): unknown;
}
```

3b. 新建 `apps/web-server/src/trace.ts`：

```typescript
/** /api/trace/* 只读端点路由（全部 GET；本地 sendJson 避免与 http.ts 循环导入）。 */
import type { ServerResponse } from "node:http";
import type { WebContext } from "./http.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 处理 /api/trace/* 请求；在 CSRF 检查之前挂载（全部为只读 GET，非 GET 一律 405）。 */
export function handleTraceApi(res: ServerResponse, ctx: WebContext, method: string, url: URL): void {
  const trace = ctx.trace;
  if (trace === undefined) {
    sendJson(res, 404, { error: "trace not available" });
    return;
  }
  if (method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  const date = url.searchParams.get("date") ?? undefined;
  if (date !== undefined && !DATE_RE.test(date)) {
    sendJson(res, 400, { error: "invalid date" });
    return;
  }
  switch (url.pathname) {
    case "/api/trace/overview":
      sendJson(res, 200, trace.overview());
      return;
    case "/api/trace/turns": {
      const sid = url.searchParams.get("sid");
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw !== null ? Number(limitRaw) : NaN;
      sendJson(res, 200, trace.turns({
        ...(date !== undefined ? { date } : {}),
        ...(sid !== null && sid !== "" ? { sid } : {}),
        ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      }));
      return;
    }
    case "/api/trace/events": {
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      if (!Number.isInteger(cursor) || cursor < 0) {
        sendJson(res, 400, { error: "invalid cursor" });
        return;
      }
      sendJson(res, 200, trace.events(cursor, date));
      return;
    }
    case "/api/trace/files":
      sendJson(res, 200, trace.files());
      return;
    default:
      sendJson(res, 404, { error: "not found" });
  }
}
```

3c. `apps/web-server/src/http.ts` — 三处：

import 区：`import { handleTraceApi } from "./trace.js";`，并把 `TraceModule` 加入对 `./types.js` 的 type import。

WebContext（L41-48）：

```typescript
// old
  /** 前端静态目录；dev 模式为 null（页面由 Vite dev server 提供）。 */
  staticDir: string | null;
  sessionStore: SessionStoreModule;
}

// new
  /** 前端静态目录；dev 模式为 null（页面由 Vite dev server 提供）。 */
  staticDir: string | null;
  sessionStore: SessionStoreModule;
  /** 可选 trace 读取模块；未注入时 /api/trace/* 返回 404。 */
  trace?: TraceModule;
}
```

handleApi 开头（L170-171，CSRF 检查之前挂载）：

```typescript
// old
): Promise<void> {
  if (method !== "GET" && method !== "HEAD" && req.headers[CSRF_HEADER] !== "1") {

// new
): Promise<void> {
  if (pathname.startsWith("/api/trace/")) {
    handleTraceApi(res, ctx, method, new URL(req.url ?? "/", "http://127.0.0.1"));
    return;
  }
  if (method !== "GET" && method !== "HEAD" && req.headers[CSRF_HEADER] !== "1") {
```

3d. `apps/web-server/src/index.ts` — 三处：

```typescript
// old (L5)
import type { BuildHarness, SessionStoreModule } from "./types.js";

// new
import type { BuildHarness, SessionStoreModule, TraceModule } from "./types.js";
```

```typescript
// old (L10)
export type { BuildHarness, SessionStoreModule } from "./types.js";

// new
export type { BuildHarness, SessionStoreModule, TraceModule } from "./types.js";
```

WebServerOptions 与 createWebServer 调用（L20-21、L63-69）：

```typescript
// old
  sessionStore: SessionStoreModule;
  buildHarness: BuildHarness;
}

// new
  sessionStore: SessionStoreModule;
  buildHarness: BuildHarness;
  /** 可选 trace 读取模块（根包注入 createTraceModule(config.workdir)）。 */
  trace?: TraceModule;
}
```

```typescript
// old
  const server = createWebServer({
    session,
    broadcaster,
    workdir,
    sessionStore: options.sessionStore,
    staticDir: options.staticDir ?? null,
  });

// new
  const server = createWebServer({
    session,
    broadcaster,
    workdir,
    sessionStore: options.sessionStore,
    staticDir: options.staticDir ?? null,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
  });
```

3e. `src/cli/web.ts` — 注入 trace 模块：

import 区（L7 后）加 `import { createTraceModule } from "../tracing/module.js";`；startWebServer 调用（L38-46）：

```typescript
// old
  return startWebServer({
    workdir: config.workdir,
    cli: options.cli,
    sessionStore: SessionStore,
    buildHarness: buildHarnessForWeb,
    staticDir: staticDir(options.dev ?? false),

// new
  return startWebServer({
    workdir: config.workdir,
    cli: options.cli,
    sessionStore: SessionStore,
    buildHarness: buildHarnessForWeb,
    staticDir: staticDir(options.dev ?? false),
    trace: createTraceModule(config.workdir),
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @blh/web-server test ; pnpm typecheck`
Expected: 新增 6 例 PASS；根包 typecheck 通过（web.ts 注入被 web-server 类型接受）

- [ ] **Step 5: Commit**

```powershell
git add apps/web-server/src/trace.ts apps/web-server/src/types.ts apps/web-server/src/http.ts apps/web-server/src/index.ts apps/web-server/test/trace.test.ts src/cli/web.ts
git commit -m "feat(web-server): add read-only /api/trace/* endpoints"
```

## Task 14: web-client traceApi

前端三个观测页统一经 `@blh/web-client` 访问 trace 端点。`api.ts` 的 `request` 已是模块内通用封装（自带 `x-blh-web: 1` 头、非 2xx 读 `body.error` 抛错），给它加 `export` 供新文件复用；新建 `trace.ts` 镜像根包 trace 类型并暴露 `traceApi` 四个方法。

**Files:**
- Create: `packages/web-client/src/trace.ts`
- Modify: `packages/web-client/src/api.ts`（request 加 export）
- Modify: `packages/web-client/src/index.ts`（导出 trace.js）
- Test: `packages/web-client/test/trace.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/web-client/test/trace.test.ts`（fetch mock 模式复刻 `api.test.ts`）：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { traceApi } from "../src/trace.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("traceApi", () => {
  it("overview 请求 /api/trace/overview 并返回结果", async () => {
    const body = {
      usage: { total: { in: 1, out: 2, costUsd: 0.01 }, byDay: {}, byProvider: {}, byModel: {} },
      today: { turns: 1, tools: 2, avgLatencyMs: 100 },
      recentTurns: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const overview = await traceApi.overview();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trace/overview",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(overview).toEqual(body);
  });

  it("turns 拼接 date/sid/limit 查询参数", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await traceApi.turns({ date: "2026-09-27", sid: "a.jsonl", limit: 10 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/trace/turns?");
    expect(url).toContain("date=2026-09-27");
    expect(url).toContain("sid=a.jsonl");
    expect(url).toContain("limit=10");
  });

  it("turns 无参数时不带查询串", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await traceApi.turns();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/trace/turns");
  });

  it("events 携带 cursor 与可选 date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ events: [], nextCursor: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await traceApi.events(5, "2026-09-27");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/trace/events?");
    expect(url).toContain("cursor=5");
    expect(url).toContain("date=2026-09-27");
  });

  it("files 返回日期列表", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(["2026-09-27"]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(traceApi.files()).resolves.toEqual(["2026-09-27"]);
  });

  it("非 2xx 抛错并带服务端 error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "trace unavailable" }, false, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(traceApi.overview()).rejects.toThrow("trace unavailable");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @blh/web-client test`
Expected: FAIL —— `Cannot find module '../src/trace.js'`

- [ ] **Step 3: 写最少实现**

`packages/web-client/src/api.ts` —— request 加 export：

```ts
// old
async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {

// new
export async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
```

创建 `packages/web-client/src/trace.ts`（类型镜像根包 `src/tracing/`，仅声明不依赖）：

```ts
import { request } from "./api.js";

export interface TraceEvent {
  ts: number;
  type: string;
  sid: string;
  turn: number;
  [key: string]: unknown;
}

export interface UsageBucket {
  in: number;
  out: number;
  costUsd: number;
}

export interface UsageSummary {
  total: UsageBucket;
  byDay: Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
}

export interface FoldedTurn {
  turn: number;
  sid: string;
  userMessage: string;
  startedAt: number;
  finished: boolean;
  cancelled: boolean;
  latencyMs: number | null;
  iterations: number;
  toolsUsed: number;
  costUsd: number;
  events: TraceEvent[];
}

export interface TraceOverview {
  usage: UsageSummary;
  today: { turns: number; tools: number; avgLatencyMs: number };
  recentTurns: FoldedTurn[];
}

export interface TraceEventsPage {
  events: TraceEvent[];
  nextCursor: number;
}

export interface TurnsQuery {
  date?: string;
  sid?: string;
  limit?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s === "" ? "" : `?${s}`;
}

export const traceApi = {
  overview(): Promise<TraceOverview> {
    return request<TraceOverview>("/api/trace/overview");
  },

  turns(opts?: TurnsQuery): Promise<FoldedTurn[]> {
    return request<FoldedTurn[]>(
      `/api/trace/turns${qs({ date: opts?.date, sid: opts?.sid, limit: opts?.limit })}`,
    );
  },

  events(cursor: number, date?: string): Promise<TraceEventsPage> {
    return request<TraceEventsPage>(`/api/trace/events${qs({ cursor, date })}`);
  },

  files(): Promise<string[]> {
    return request<string[]>("/api/trace/files");
  },
};
```

`packages/web-client/src/index.ts` —— 导出 trace.js：

```ts
// old
export * from "./api.js";
export { reportLogs } from "./log.js";

// new
export * from "./api.js";
export * from "./trace.js";
export { reportLogs } from "./log.js";
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @blh/web-client test ; pnpm --filter @blh/web-client typecheck`
Expected: 新增 6 例 PASS；typecheck 通过（若该包无 typecheck 脚本则跳过并改用根 `pnpm typecheck`）

- [ ] **Step 5: Commit**

```powershell
git add packages/web-client/src/trace.ts packages/web-client/src/api.ts packages/web-client/src/index.ts packages/web-client/test/trace.test.ts
git commit -m "feat(web-client): add traceApi for /api/trace/* endpoints"
```

## Task 15: 前端 hash 路由 + 侧边栏 Observe 导航 + 页面外壳

`apps/web` 无单测设施，前端用既有 Playwright e2e（`e2e/mock-server.mjs` + vite 代理 `/api`→8123）做 TDD。本任务建路由骨架：侧边栏底部加 Observe 导航区，`#/observe/*` 切换到观测视图；三个页面先实现为只含标题的外壳（TDD 最小实现，Task 16-18 各自补数据渲染）。

**Files:**
- Create: `apps/web/e2e/observe.spec.ts`
- Create: `apps/web/src/components/observe/OverviewPage.tsx`（外壳）
- Create: `apps/web/src/components/observe/TracePage.tsx`（外壳）
- Create: `apps/web/src/components/observe/OpsPage.tsx`（外壳）
- Modify: `apps/web/src/App.tsx`（hash 路由）
- Modify: `apps/web/src/components/SessionSidebar.tsx`（route prop + 导航区）
- Modify: `apps/web/src/styles.css`（observe 导航样式）

- [ ] **Step 1: 写失败 e2e 测试**

创建 `apps/web/e2e/observe.spec.ts`：

```ts
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:8123/api/__reset");
});

test("侧边栏显示 Observe 导航区", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Trace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ops" })).toBeVisible();
});

test("点击 Trace 链接切换 hash 并显示 Trace 页", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Trace" }).click();
  await expect(page).toHaveURL(/#\/observe\/trace$/);
  await expect(page.getByRole("heading", { name: "Trace" })).toBeVisible();
});

test("从观测页返回对话", async ({ page }) => {
  await page.goto("/#/observe/trace");
  await page.getByRole("link", { name: "对话" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByPlaceholder("输入消息…")).toBeVisible();
});

test("深链接直接打开 Ops 页", async ({ page }) => {
  await page.goto("/#/observe/ops");
  await expect(page.getByRole("heading", { name: "Ops" })).toBeVisible();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts`
Expected: FAIL —— 4 例均找不到 Observe 导航链接/观测页标题

- [ ] **Step 3: 写最少实现**

**3a. `apps/web/src/App.tsx`** —— 整文件替换为：

```tsx
import { useEffect, useState } from "react";
// 封装与后端 agent 的事件通信，统一管理会话、消息、工具事件等状态
import { useAgentEvents } from "./hooks/useAgentEvents";
// 聊天消息展示面板
import { ChatPanel } from "./components/ChatPanel";
// 底部输入框，用于发送消息
import { InputBar } from "./components/InputBar";
// 工具调用审批弹窗
import { ApprovalModal } from "./components/ApprovalModal";
// 左侧会话列表侧边栏
import { SessionSidebar } from "./components/SessionSidebar";
// 观测页（Overview / Trace / Ops），经 hash 路由切换
import { OverviewPage } from "./components/observe/OverviewPage";
import { TracePage } from "./components/observe/TracePage";
import { OpsPage } from "./components/observe/OpsPage";

/** 监听 location.hash 的轻量路由：聊天为主视图，#/observe/* 切到观测页。 */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

// 应用根组件
export function App() {
  // 从 hook 中获取 agent 相关的全部状态与操作方法
  const state = useAgentEvents();
  // 侧边栏是否折叠
  const [collapsed, setCollapsed] = useState(false);
  const route = useHashRoute();
  const observePage = route.startsWith("#/observe/") ? route.slice("#/observe/".length) : null;

  return (
    // 根据折叠状态拼接样式类名，折叠时额外追加 app-collapsed
    <div className={`app${collapsed ? " app-collapsed" : ""}`}>
      <SessionSidebar
        sessions={state.sessions}
        activeId={state.sessionId}
        loading={state.sessionLoading}
        collapsed={collapsed}
        route={route}
        onToggle={() => setCollapsed((c) => !c)}
        onNew={() => void state.createSession()}
        onResume={(file) => void state.resume(file)}
        onDelete={(file) => void state.deleteSession(file)}
      />
      {observePage === null ? (
        <main className="main">
          <ChatPanel
            messages={state.messages}
            streaming={state.streaming}
            toolEvents={state.toolEvents}
            busy={state.busy}
            approval={state.approval}
          />
          {/* 有错误时在顶部显示错误横幅 */}
          {state.error !== null && <div className="error-banner">{state.error}</div>}
          <InputBar
            busy={state.busy}
            canStop={state.canStop}
            onSend={(text) => void state.send(text)}
            onStop={() => void state.stop()}
          />
        </main>
      ) : (
        <main className="main observe-main">
          {observePage === "trace" ? <TracePage /> : observePage === "ops" ? <OpsPage /> : <OverviewPage />}
        </main>
      )}
      <ApprovalModal approval={state.approval} onRespond={(d) => void state.respond(d)} />
    </div>
  );
}
```

**3b. `apps/web/src/components/SessionSidebar.tsx`** —— 三处修改：

props 类型加 route：

```tsx
// old
export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  loading: boolean;
  collapsed: boolean;
  onToggle(): void;

// new
export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  loading: boolean;
  collapsed: boolean;
  route: string;
  onToggle(): void;
```

解构加 route：

```tsx
// old
  const { sessions, activeId, loading, collapsed, onToggle, onNew, onResume, onDelete } = props;

// new
  const { sessions, activeId, loading, collapsed, route, onToggle, onNew, onResume, onDelete } = props;
```

`</aside>` 前加 Observe 导航区（session-region 是 flex:1，nav 自然落底）：

```tsx
// old
      </div>
    </aside>
  );
}

// new
      </div>

      <nav className="observe-nav" aria-label="观测页导航">
        {collapsed ? null : (
          <>
            <span className="observe-nav-title">Observe</span>
            <a className={`observe-link${route === "" || route === "#/" ? " active" : ""}`} href="#/">
              对话
            </a>
            <a className={`observe-link${route === "#/observe/overview" ? " active" : ""}`} href="#/observe/overview">
              Overview
            </a>
            <a className={`observe-link${route === "#/observe/trace" ? " active" : ""}`} href="#/observe/trace">
              Trace
            </a>
            <a className={`observe-link${route === "#/observe/ops" ? " active" : ""}`} href="#/observe/ops">
              Ops
            </a>
          </>
        )}
      </nav>
    </aside>
  );
}
```

**3c. 页面外壳** —— 新建 `apps/web/src/components/observe/OverviewPage.tsx`：

```tsx
export function OverviewPage() {
  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Overview</h1>
      </header>
    </div>
  );
}
```

新建 `apps/web/src/components/observe/TracePage.tsx`：

```tsx
export function TracePage() {
  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Trace</h1>
      </header>
    </div>
  );
}
```

新建 `apps/web/src/components/observe/OpsPage.tsx`：

```tsx
export function OpsPage() {
  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Ops</h1>
      </header>
    </div>
  );
}
```

**3d. `apps/web/src/styles.css`** —— 文件末尾（`.modal-actions button.primary:hover` 规则之后）追加：

```css

/* ============ observe 导航与页面骨架 ============ */
.observe-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.observe-nav-title {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  padding: 4px 8px;
}
.observe-link {
  display: block;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  text-decoration: none;
}
.observe-link:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
.observe-link.active {
  background: var(--dsw-specific-sidebar-nav-item-active);
  color: var(--dsw-alias-label-primary);
}
.observe-main { overflow-y: auto; }
.observe-page { padding: 20px 24px; max-width: 1080px; }
.observe-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.observe-header h1 { margin: 0; font-size: 18px; line-height: 26px; }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts ; pnpm --filter @blh/web typecheck`
Expected: 4 例 PASS；typecheck 通过（既有 workbench.spec.ts 也应仍 PASS，可一并跑 `pnpm --filter @blh/web test:e2e` 确认）

- [ ] **Step 5: Commit**

```powershell
git add apps/web/e2e/observe.spec.ts apps/web/src/App.tsx apps/web/src/components/SessionSidebar.tsx apps/web/src/components/observe apps/web/src/styles.css
git commit -m "feat(web): add hash routing and observe nav with page shells"
```

## Task 16: OverviewPage 数据渲染

按规格 3.6：统计卡片（总花费 / turns / 工具数 / 平均延迟）+ 近 14 天成本条形图（纯 CSS，不新增依赖）+ 最近 5 个 turns 摘要。数据源 `traceApi.overview()`，5s 轮询 + 手动刷新。

**Files:**
- Modify: `apps/web/src/components/observe/OverviewPage.tsx`（外壳 → 完整实现）
- Modify: `apps/web/e2e/mock-server.mjs`（stub `/api/trace/overview`）
- Modify: `apps/web/e2e/observe.spec.ts`（增补断言）
- Modify: `apps/web/src/styles.css`（stat-card / cost-bar / turn-row 样式）

- [ ] **Step 1: 写失败 e2e 测试**

`apps/web/e2e/observe.spec.ts` 末尾追加：

```ts
test("Overview 页显示统计卡片、成本图与最近 turns", async ({ page }) => {
  await page.goto("/#/observe/overview");
  await expect(page.locator(".stat-card", { hasText: "总花费" })).toContainText("$0.4200");
  await expect(page.locator(".stat-card", { hasText: "今日 turns" })).toContainText("3");
  await expect(page.locator(".stat-card", { hasText: "平均延迟" })).toContainText("1.5s");
  await expect(page.locator(".cost-bar-col")).toHaveCount(2);
  await expect(page.getByText("查一下 trace 文件")).toBeVisible();
});
```

`apps/web/e2e/mock-server.mjs` 两处修改——`sessions` 定义后加 fixture：

```js
// old
const sessions = [
  { file: "session_1.jsonl", mtime: Date.now(), preview: "历史会话" },
];

// new
const sessions = [
  { file: "session_1.jsonl", mtime: Date.now(), preview: "历史会话" },
];

const traceOverview = {
  usage: {
    total: { in: 12000, out: 3000, costUsd: 0.42 },
    byDay: {
      "2026-09-26": { in: 4000, out: 1000, costUsd: 0.14 },
      "2026-09-27": { in: 8000, out: 2000, costUsd: 0.28 },
    },
    byProvider: { deepseek: { in: 12000, out: 3000, costUsd: 0.42 } },
    byModel: { "deepseek-chat": { in: 12000, out: 3000, costUsd: 0.42 } },
  },
  today: { turns: 3, tools: 5, avgLatencyMs: 1500 },
  recentTurns: [
    {
      turn: 3,
      sid: "session_1.jsonl",
      userMessage: "查一下 trace 文件",
      startedAt: Date.now(),
      finished: true,
      cancelled: false,
      latencyMs: 2100,
      iterations: 2,
      toolsUsed: 1,
      costUsd: 0.003,
      events: [],
    },
  ],
};
```

404 兜底前加端点：

```js
// old
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// new
  if (method === "GET" && pathname === "/api/trace/overview") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceOverview));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts`
Expected: FAIL —— 新用例找不到 `.stat-card`（页面还是外壳）

- [ ] **Step 3: 写最少实现**

`apps/web/src/components/observe/OverviewPage.tsx` 整文件替换为：

```tsx
import { useCallback, useEffect, useState } from "react";
import { traceApi, type TraceOverview } from "@blh/web-client";

/** 近 14 天成本条形图（纯 CSS，无图表依赖）。 */
function CostBars(props: { byDay: Record<string, { costUsd: number }> }) {
  const days = Object.entries(props.byDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-14);
  if (days.length === 0) return <p className="observe-empty">暂无成本数据</p>;
  const max = days.reduce((m, [, b]) => Math.max(m, b.costUsd), 0);
  return (
    <div className="cost-bars">
      {days.map(([day, b]) => (
        <div className="cost-bar-col" key={day} title={`${day} $${b.costUsd.toFixed(4)}`}>
          <div
            className="cost-bar"
            style={{ height: `${max > 0 ? Math.max(2, Math.round((b.costUsd / max) * 100)) : 2}%` }}
          />
          <span className="cost-bar-label">{day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

export function OverviewPage() {
  const [data, setData] = useState<TraceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await traceApi.overview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Overview</h1>
        <button type="button" className="observe-refresh" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error !== null && <div className="error-banner">{error}</div>}
      {data === null ? (
        <p className="observe-empty">加载中…</p>
      ) : (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <span className="stat-label">总花费</span>
              <span className="stat-value">${data.usage.total.costUsd.toFixed(4)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">今日 turns</span>
              <span className="stat-value">{data.today.turns}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">今日工具调用</span>
              <span className="stat-value">{data.today.tools}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">平均延迟</span>
              <span className="stat-value">{(data.today.avgLatencyMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          <section className="observe-section">
            <h2>近 14 天成本</h2>
            <CostBars byDay={data.usage.byDay} />
          </section>

          <section className="observe-section">
            <h2>最近 turns</h2>
            {data.recentTurns.length === 0 ? (
              <p className="observe-empty">今日暂无 turn</p>
            ) : (
              <ul className="turn-list">
                {data.recentTurns.map((t) => (
                  <li className="turn-row" key={`${t.sid}#${t.turn}`}>
                    <span className="turn-msg">{t.userMessage !== "" ? t.userMessage : "(空消息)"}</span>
                    <span className="turn-meta">
                      {t.latencyMs !== null ? `${(t.latencyMs / 1000).toFixed(1)}s` : "—"} · {t.iterations} 迭代 ·{" "}
                      {t.toolsUsed} 工具 · ${t.costUsd.toFixed(4)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
```

`apps/web/src/styles.css` 文件末尾追加：

```css

/* ============ observe 统计卡片与图表 ============ */
.observe-refresh {
  padding: 6px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  cursor: pointer;
}
.observe-refresh:hover { background: var(--dsw-alias-button-floating-hover); }
.observe-empty { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.observe-section { margin-bottom: 24px; }
.observe-section h2 { font-size: 14px; margin: 0 0 10px; color: var(--dsw-alias-label-secondary); }
.stat-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.stat-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.stat-value { font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.cost-bars { display: flex; align-items: flex-end; gap: 6px; height: 120px; }
.cost-bar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  width: 32px;
  gap: 4px;
}
.cost-bar {
  width: 20px;
  background: var(--dsw-static-deepseek-400);
  border-radius: 4px 4px 0 0;
}
.cost-bar-label { font-size: 10px; color: var(--dsw-alias-label-caption); }
.turn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.turn-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 13px;
}
.turn-msg {
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.turn-meta { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts ; pnpm --filter @blh/web typecheck`
Expected: 5 例 PASS；typecheck 通过

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/components/observe/OverviewPage.tsx apps/web/e2e/mock-server.mjs apps/web/e2e/observe.spec.ts apps/web/src/styles.css
git commit -m "feat(web): render overview page with stat cards and cost bars"
```

## Task 17: TracePage 数据渲染

按规格 3.6：会话选择器 + 日期选择器 + turn 卡片列表（用户消息、每次 LLM 迭代行 model/usage/耗时、工具调用行状态点 + 可展开 args/output 摘要、审批徽标、脚注耗时/迭代数/成本）。

**与规格的一处偏差（已在设计阶段决定）**：规格原文写 `events?cursor` 1s 轮询自动跟随。实现改为 **1s 轮询 `turns` API 直接重拉整页**——`turns` 返回的 `FoldedTurn.events` 已含每个 turn 全部事件，跟随效果等同且更简单，无需客户端维护游标与增量合并。`events?cursor` 端点的实际消费者是 Ops 页（Task 18 的 trace 原文浏览）。

数据源：`traceApi.files()`（日期列表）、`listSessions()`（会话选择器，复用 web-client 现有 API）、`traceApi.turns({ date, sid })`（1s 轮询）。

**Files:**
- Modify: `apps/web/src/components/observe/TracePage.tsx`（外壳 → 完整实现）
- Modify: `apps/web/e2e/mock-server.mjs`（stub `/api/trace/files` + `/api/trace/turns`）
- Modify: `apps/web/e2e/observe.spec.ts`（增补断言）
- Modify: `apps/web/src/styles.css`（trace 卡片/行/徽标样式）

- [ ] **Step 1: 写失败 e2e 测试**

`apps/web/e2e/observe.spec.ts` 末尾追加：

```ts
test("Trace 页显示日期/会话选择器与 turn 卡片", async ({ page }) => {
  await page.goto("/#/observe/trace");
  await expect(page.locator(".trace-toolbar select").first()).toBeVisible();
  await expect(page.getByText("查一下 trace 文件")).toBeVisible();
  await expect(page.locator(".trace-llm-row")).toContainText("deepseek-chat");
  await expect(page.locator(".trace-tool-row")).toContainText("read_file");
  await expect(page.getByText("进行中")).toBeVisible();
});

test("Trace 页展开工具行显示输出摘要", async ({ page }) => {
  await page.goto("/#/observe/trace");
  await page.locator(".trace-tool-row button").click();
  await expect(page.getByText("file content")).toBeVisible();
});
```

`apps/web/e2e/mock-server.mjs` 两处修改——`traceOverview` 定义前加 fixture：

```js
// old
const traceOverview = {

// new
const traceFiles = ["2026-09-27"];

const traceTurns = [
  {
    turn: 1,
    sid: "session_1.jsonl",
    userMessage: "查一下 trace 文件",
    startedAt: Date.now(),
    finished: false,
    cancelled: false,
    latencyMs: null,
    iterations: 1,
    toolsUsed: 1,
    costUsd: 0.001,
    events: [
      { ts: 1000, type: "turn_start", sid: "session_1.jsonl", turn: 1, user_message: "查一下 trace 文件" },
      { ts: 1100, type: "llm", sid: "session_1.jsonl", turn: 1, provider: "deepseek", model: "deepseek-chat", status: "ok", latency_ms: 80, usage: { promptTokens: 10, completionTokens: 5 } },
      { ts: 1200, type: "tool", sid: "session_1.jsonl", turn: 1, tool: "read_file", args_summary: "…", latency_ms: 20, status: "ok", output_summary: "file content" },
    ],
  },
];

const traceOverview = {
```

`/api/trace/overview` 端点前加 files/turns 端点：

```js
// old
  if (method === "GET" && pathname === "/api/trace/overview") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceOverview));
    return;
  }

// new
  if (method === "GET" && pathname === "/api/trace/files") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceFiles));
    return;
  }
  if (method === "GET" && pathname === "/api/trace/turns") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceTurns));
    return;
  }
  if (method === "GET" && pathname === "/api/trace/overview") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceOverview));
    return;
  }
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts`
Expected: FAIL —— 新用例找不到 `.trace-toolbar`（页面还是外壳）

- [ ] **Step 3: 写最少实现**

`apps/web/src/components/observe/TracePage.tsx` 整文件替换为：

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  listSessions,
  traceApi,
  type FoldedTurn,
  type SessionListItem,
  type TraceEvent,
} from "@blh/web-client";

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 单次 LLM 迭代行。 */
function LlmRow(props: { e: TraceEvent }) {
  const { e } = props;
  const usage = e.usage as { promptTokens?: number; completionTokens?: number } | null | undefined;
  const tokens =
    usage !== null && usage !== undefined
      ? `${usage.promptTokens ?? 0}+${usage.completionTokens ?? 0} tokens`
      : "—";
  return (
    <div className={`trace-llm-row trace-row${e.status === "error" ? " is-error" : ""}`}>
      <span className="trace-dot" />
      <span className="trace-kind">LLM</span>
      <span className="trace-main">
        {str(e.model)}
        <span className="trace-sub">{tokens} · {num(e.latency_ms) !== null ? `${num(e.latency_ms)}ms` : "—"}</span>
      </span>
      {e.status === "error" ? <span className="trace-badge danger">失败</span> : null}
    </div>
  );
}

/** 单次工具调用行，点击展开输出摘要。 */
function ToolRow(props: { e: TraceEvent }) {
  const { e } = props;
  const [open, setOpen] = useState(false);
  const status = str(e.status);
  return (
    <div className="trace-tool-row trace-row">
      <span className={`trace-dot${status === "error" ? " is-error" : status === "denied" ? " is-denied" : ""}`} />
      <span className="trace-kind">TOOL</span>
      <span className="trace-main">
        {str(e.tool)}
        <span className="trace-sub">{str(e.args_summary)} · {num(e.latency_ms) !== null ? `${num(e.latency_ms)}ms` : "—"}</span>
      </span>
      {status !== "ok" && status !== "" ? <span className="trace-badge warn">{status}</span> : null}
      {e.output_summary !== undefined && str(e.output_summary) !== "" && (
        <button type="button" className="trace-expand" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "输出"}
        </button>
      )}
      {open && <pre className="trace-output">{str(e.output_summary)}</pre>}
    </div>
  );
}

/** 单个 turn 卡片：标题 + 事件行 + 脚注。 */
function TurnCard(props: { turn: FoldedTurn }) {
  const { turn } = props;
  return (
    <article className="trace-turn">
      <header className="trace-turn-header">
        <span className="trace-turn-msg">{turn.userMessage !== "" ? turn.userMessage : "(空消息)"}</span>
        {!turn.finished ? (
          <span className="trace-badge">进行中</span>
        ) : turn.cancelled ? (
          <span className="trace-badge warn">已取消</span>
        ) : null}
      </header>
      <div className="trace-events">
        {turn.events
          .filter((e) => e.type === "llm" || e.type === "tool" || e.type === "approval")
          .map((e, i) =>
            e.type === "llm" ? (
              <LlmRow key={i} e={e} />
            ) : e.type === "tool" ? (
              <ToolRow key={i} e={e} />
            ) : (
              <div key={i} className="trace-approval">
                <span className={`trace-badge ${e.decision === "deny" ? "danger" : ""}`}>
                  审批 {str(e.decision)}
                </span>
                <span className="trace-sub">{str(e.tool)} · {str(e.rule)}</span>
              </div>
            ),
          )}
      </div>
      <footer className="trace-turn-footer">
        {turn.latencyMs !== null ? `${(turn.latencyMs / 1000).toFixed(1)}s` : "—"} · {turn.iterations} 迭代 ·{" "}
        {turn.toolsUsed} 工具 · ${turn.costUsd.toFixed(4)}
      </footer>
    </article>
  );
}

export function TracePage() {
  const [dates, setDates] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [date, setDate] = useState("");
  const [sid, setSid] = useState("");
  const [turns, setTurns] = useState<FoldedTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTurns(await traceApi.turns({ date, sid }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date, sid]);

  useEffect(() => {
    void traceApi.files().then(setDates).catch(() => {});
    void listSessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Trace</h1>
        <button type="button" className="observe-refresh" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error !== null && <div className="error-banner">{error}</div>}
      <div className="trace-toolbar">
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          <option value="">今天</option>
          {dates.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select value={sid} onChange={(e) => setSid(e.target.value)}>
          <option value="">全部会话</option>
          {sessions.map((s) => (
            <option key={s.file} value={s.file}>{s.file}</option>
          ))}
        </select>
      </div>
      {turns.length === 0 ? (
        <p className="observe-empty">暂无 turn</p>
      ) : (
        <div className="trace-turn-list">
          {turns.map((t) => (
            <TurnCard key={`${t.sid}#${t.turn}`} turn={t} />
          ))}
        </div>
      )}
    </div>
  );
}
```

`apps/web/src/styles.css` 文件末尾追加：

```css

/* ============ observe Trace 页 ============ */
.trace-toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
.trace-toolbar select {
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.trace-turn-list { display: flex; flex-direction: column; gap: 12px; }
.trace-turn {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  overflow: hidden;
}
.trace-turn-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-static-neutral-bluish-50);
}
.trace-turn-msg {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-events { padding: 8px 14px; display: flex; flex-direction: column; gap: 6px; }
.trace-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}
.trace-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-static-deepseek-400);
  flex-shrink: 0;
}
.trace-dot.is-error { background: var(--dsw-static-red-500); }
.trace-dot.is-denied { background: var(--dsw-static-amber-500); }
.trace-kind {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  width: 40px;
  flex-shrink: 0;
}
.trace-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.trace-sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.trace-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-static-deepseek-100);
  color: var(--dsw-static-deepseek-500);
}
.trace-badge.warn { background: var(--dsw-static-amber-100); color: var(--dsw-static-amber-500); }
.trace-badge.danger { background: var(--dsw-static-red-100); color: var(--dsw-static-red-600); }
.trace-expand {
  border: none;
  background: none;
  color: var(--dsw-static-deepseek-500);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.trace-output {
  flex-basis: 100%;
  margin: 0;
  padding: 8px 10px;
  background: var(--dsw-static-neutral-bluish-75);
  border-radius: 8px;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow: auto;
  max-height: 160px;
}
.trace-approval { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.trace-turn-footer {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  border-top: 1px solid var(--dsw-alias-border-l1);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts ; pnpm --filter @blh/web typecheck`
Expected: 7 例 PASS；typecheck 通过

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/components/observe/TracePage.tsx apps/web/e2e/mock-server.mjs apps/web/e2e/observe.spec.ts apps/web/src/styles.css
git commit -m "feat(web): render trace page with turn cards and event rows"
```

## Task 18: OpsPage 数据渲染

按规格 3.6：成本表（按天 / provider / 模型）、最慢 10 个 turns、审批决策表、trace 原文浏览（最近 200 行）。

**与规格的一处措辞偏差（如实实现，不编造）**：规格原文写审批决策表为 "allow/deny/ask 计数"。但事件模型（Task 8 的 `approval` 事件）的 `decision` 字段只落盘最终裁决 `allow` / `deny`；`ask`（向用户问询）是中间态、不写 trace。故审批表只统计 `allow` / `deny` 计数并给出明细（tool/decision/rule/source），不在前端虚构一个恒为 0 的 `ask` 列。

数据源：`traceApi.overview()`（成本三表）、`traceApi.turns({ limit: 100 })`（最慢 turns + 审批明细聚合）、`traceApi.events(0)`（trace 原文，取最近 200 行）。

**Files:**
- Modify: `apps/web/src/components/observe/OpsPage.tsx`（外壳 → 完整实现）
- Modify: `apps/web/e2e/mock-server.mjs`（stub `/api/trace/events` + traceTurns 加 approval 事件）
- Modify: `apps/web/e2e/observe.spec.ts`（增补断言）
- Modify: `apps/web/src/styles.css`（ops 表/审批/trace 原文样式）

- [ ] **Step 1: 写失败 e2e 测试**

`apps/web/e2e/observe.spec.ts` 末尾追加：

```ts
test("Ops 页显示成本表、审批表与 trace 原文", async ({ page }) => {
  await page.goto("/#/observe/ops");
  await expect(page.locator(".ops-table")).toContainText("deepseek");
  await expect(page.locator(".ops-approval")).toContainText("allow");
  await expect(page.locator(".ops-approval")).toContainText("1");
  await expect(page.locator(".ops-raw")).toContainText("turn_start");
  await expect(page.locator(".ops-slowest")).toContainText("查一下 trace 文件");
});
```

`apps/web/e2e/mock-server.mjs` 三处修改。

**① traceTurns 的 events 里加 approval 事件**（锚定 tool 事件行）：

```js
// old
      { ts: 1200, type: "tool", sid: "session_1.jsonl", turn: 1, tool: "read_file", args_summary: "…", latency_ms: 20, status: "ok", output_summary: "file content" },
    ],
  },
];

// new
      { ts: 1200, type: "tool", sid: "session_1.jsonl", turn: 1, tool: "read_file", args_summary: "…", latency_ms: 20, status: "ok", output_summary: "file content" },
      { ts: 1300, type: "approval", sid: "session_1.jsonl", turn: 1, tool: "bash", decision: "allow", rule: "user", source: "web" },
    ],
  },
];
```

**② `traceFiles` 定义后加 trace 原文 fixture**：

```js
// old
const traceFiles = ["2026-09-27"];

// new
const traceFiles = ["2026-09-27"];

const traceEvents = {
  events: [
    { ts: 1000, type: "turn_start", sid: "session_1.jsonl", turn: 1, user_message: "查一下 trace 文件" },
    { ts: 1100, type: "llm", sid: "session_1.jsonl", turn: 1, model: "deepseek-chat" },
  ],
  nextCursor: 2,
};
```

**③ `/api/trace/turns` 端点后加 events 端点**：

```js
// old
  if (method === "GET" && pathname === "/api/trace/turns") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceTurns));
    return;
  }

// new
  if (method === "GET" && pathname === "/api/trace/turns") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceTurns));
    return;
  }
  if (method === "GET" && pathname === "/api/trace/events") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceEvents));
    return;
  }
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts`
Expected: FAIL —— 新用例找不到 `.ops-table`（页面还是外壳）

- [ ] **Step 3: 写最少实现**

`apps/web/src/components/observe/OpsPage.tsx` 整文件替换为：

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  traceApi,
  type FoldedTurn,
  type TraceEvent,
  type TraceOverview,
  type UsageBucket,
} from "@blh/web-client";

function fmtLatency(ms: number | null): string {
  return ms !== null ? `${(ms / 1000).toFixed(1)}s` : "—";
}

function CostTable(props: { title: string; buckets: Record<string, UsageBucket> }) {
  const rows = Object.entries(props.buckets).sort(([a], [b]) => (a < b ? -1 : 1));
  if (rows.length === 0) return <p className="observe-empty">暂无数据</p>;
  return (
    <section className="observe-section">
      <h2>{props.title}</h2>
      <table className="ops-table">
        <thead>
          <tr><th>名称</th><th>输入 tokens</th><th>输出 tokens</th><th>成本</th></tr>
        </thead>
        <tbody>
          {rows.map(([k, b]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{b.in}</td>
              <td>{b.out}</td>
              <td>${b.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function collectApprovals(turns: FoldedTurn[]): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const t of turns) {
    for (const e of t.events) {
      if (e.type === "approval") out.push(e);
    }
  }
  return out;
}

export function OpsPage() {
  const [overview, setOverview] = useState<TraceOverview | null>(null);
  const [turns, setTurns] = useState<FoldedTurn[]>([]);
  const [raw, setRaw] = useState<TraceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ov, tns, page] = await Promise.all([
        traceApi.overview(),
        traceApi.turns({ limit: 100 }),
        traceApi.events(0),
      ]);
      setOverview(ov);
      setTurns(tns);
      setRaw(page.events.slice(-200));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approvals = collectApprovals(turns);
  const allowCount = approvals.filter((e) => e.decision === "allow").length;
  const denyCount = approvals.filter((e) => e.decision === "deny").length;
  const slowest = [...turns]
    .filter((t) => t.latencyMs !== null)
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
    .slice(0, 10);

  return (
    <div className="observe-page">
      <header className="observe-header">
        <h1>Ops</h1>
        <button type="button" className="observe-refresh" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error !== null && <div className="error-banner">{error}</div>}
      {overview === null ? (
        <p className="observe-empty">加载中…</p>
      ) : (
        <>
          <CostTable title="按天" buckets={overview.usage.byDay} />
          <CostTable title="按 provider" buckets={overview.usage.byProvider} />
          <CostTable title="按模型" buckets={overview.usage.byModel} />

          <section className="observe-section">
            <h2>审批决策</h2>
            <div className="ops-approval">
              <span className="trace-badge">allow {allowCount}</span>
              <span className="trace-badge danger">deny {denyCount}</span>
            </div>
            {approvals.length === 0 ? (
              <p className="observe-empty">暂无审批记录</p>
            ) : (
              <table className="ops-table">
                <thead>
                  <tr><th>工具</th><th>决策</th><th>规则</th><th>来源</th></tr>
                </thead>
                <tbody>
                  {approvals.map((e, i) => (
                    <tr key={i}>
                      <td>{typeof e.tool === "string" ? e.tool : "—"}</td>
                      <td>{typeof e.decision === "string" ? e.decision : "—"}</td>
                      <td>{typeof e.rule === "string" ? e.rule : "—"}</td>
                      <td>{typeof e.source === "string" ? e.source : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="observe-section">
            <h2>最慢 10 个 turns</h2>
            {slowest.length === 0 ? (
              <p className="observe-empty">暂无已完成 turn</p>
            ) : (
              <ul className="turn-list ops-slowest">
                {slowest.map((t) => (
                  <li className="turn-row" key={`${t.sid}#${t.turn}`}>
                    <span className="turn-msg">{t.userMessage !== "" ? t.userMessage : "(空消息)"}</span>
                    <span className="turn-meta">{fmtLatency(t.latencyMs)} · ${t.costUsd.toFixed(4)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="observe-section">
            <h2>trace 原文（最近 {raw.length} 行）</h2>
            {raw.length === 0 ? (
              <p className="observe-empty">暂无事件</p>
            ) : (
              <pre className="ops-raw">
                {raw.map((e, i) => JSON.stringify(e)).join("\n")}
              </pre>
            )}
          </section>
        </>
      )}
    </div>
  );
}
```

`apps/web/src/styles.css` 文件末尾追加：

```css

/* ============ observe Ops 页 ============ */
.ops-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ops-table th, .ops-table td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.ops-table th { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.ops-approval { display: flex; gap: 8px; margin-bottom: 8px; }
.ops-raw {
  margin: 0;
  padding: 12px;
  background: var(--dsw-static-neutral-bluish-75);
  border-radius: 8px;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow: auto;
  max-height: 320px;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @blh/web test:e2e -- observe.spec.ts ; pnpm --filter @blh/web typecheck`
Expected: 8 例 PASS；typecheck 通过

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/components/observe/OpsPage.tsx apps/web/e2e/mock-server.mjs apps/web/e2e/observe.spec.ts apps/web/src/styles.css
git commit -m "feat(web): render ops page with cost tables, approvals and raw trace"
```

## Task 19: 全量回归验证

所有代码已在前 18 个 Task 中 TDD 完成并逐步提交。本任务做一次跨包全量回归，确认 trace 埋点没有破坏既有 loop / 安全 / 前端链路，且各包测试、类型、构建全部通过。无新增代码，仅验证。

- [ ] **Step 1: 根包单测 + 类型**

Run: `pnpm test ; pnpm typecheck`

Expected: 根包全部 Vitest 用例 PASS（含新增 test/tracing/*、loop/approval/compactor/memory/subagent/workflow 增补）；`tsc --noEmit` 无错误

- [ ] **Step 2: web-server 单测**

Run: `pnpm --filter @blh/web-server test`

Expected: 全部 PASS（含新增 apps/web-server/test/trace.test.ts 6 例）

- [ ] **Step 3: web-client 单测 + 类型**

Run: `pnpm --filter @blh/web-client test ; pnpm --filter @blh/web-client typecheck`

Expected: 全部 PASS（含新增 packages/web-client/test/trace.test.ts 6 例）；typecheck 无错误

- [ ] **Step 4: web 前端类型 + 构建**

Run: `pnpm --filter @blh/web typecheck ; pnpm --filter @blh/web build`

Expected: `tsc --noEmit` 无错误；`vite build` 成功产出到 `dist/web`

- [ ] **Step 5: web e2e 全量**

Run: `pnpm --filter @blh/web test:e2e`

Expected: workbench.spec.ts（9 例）与 observe.spec.ts（8 例）全部 PASS

- [ ] **Step 6: 根包构建（CLI 产物）**

Run: `pnpm build`

Expected: `tsc -p tsconfig.build.json` 成功产出 `dist/cli`

- [ ] **Step 7: 自检清单**（无命令，逐项核对）

- [ ] 规格 3.1-3.7 全部落地：`src/tracing/`（types/tracer/pricing/fold/module）、web-server 四只读端点、web-client traceApi、前端三观测页 + 导航
- [ ] 11 种事件类型均有埋点写入（turn_start/end/cancelled、llm、tool、approval、compact、memory、subagent、workflow、goal、job）
- [ ] 包依赖方向未破坏：web-server 只定义 `TraceModule` 接口由根包注入，无反向依赖根包
- [ ] 无占位符：全计划 grep 无 `TODO`/`FIXME`/`placeholder`/`...` 遗留实现占位（事件里的 `…` 是 summarize 截断文案，非占位）
- [ ] 规格第 6 节非目标未越界：无 OTel 导出、无 CLI trace 查看器、无实时架构点亮图、无 trace 清理策略

> 本 Task 无代码变更，无需 commit。全部通过即告完成。

---

## 计划自检（执行前最后确认）

- **规格覆盖**：3.1（src/tracing）→ Task 1-5；3.2/3.3（事件模型 + Tracer）→ Task 1-2；3.4（pricing 账本）→ Task 4；3.5（web-server 端点）→ Task 6-13；3.6（前端三观测页）→ Task 14-18；3.7（数据流接线）→ Task 7/12/13。全覆盖。
- **TDD**：每个代码 Task 均「写失败测试 → 验证失败 → 最少实现 → 验证通过 → commit」五步；前端因无单测设施改用 Playwright e2e 同节奏 TDD。
- **两处已注明的规格偏差**：①Trace 页跟随改用 `turns` 1s 轮询（Task 17）；②审批表只统计 allow/deny、无虚构 ask 列（Task 18）。均已在对应 Task 正文标注理由。
