/** workflow 运行时:runner、budget、ExecutionState 编排原语。 */
import { MISS, SimpleJsonSchema, WorkflowInputError, stableHash, parseRunnerJson, stableStringify, type JsonSchema } from "./schema.js";
import type { WorkflowJournal } from "./journal.js";
import type { OpenAICompatProvider } from "../providers/openai-compat.js";

export const AGENT_CAP = 1000;
export const CONCURRENCY = 8;

export interface RunnerOutput {
  value: unknown;
  tokens: number;
}

export interface WorkflowRunner {
  run(prompt: string, schema?: JsonSchema, label?: string): Promise<RunnerOutput>;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: string[];
}

export type WorkflowFn = (ctx: ExecutionState, args: Record<string, unknown>) => Promise<unknown>;
export type WorkflowRegistry = Map<string, [WorkflowMeta, WorkflowFn]>;

export interface WorkflowTaskLike {
  usage: { agents: number; tokens: number };
  progressEvent(ptype: string, data: Record<string, unknown>): void;
}

class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.permits += 1;
  }
}

/** workflow 子 agent:无 tools 单轮,复用 host 的 OpenAI provider,拿 usage 记账。 */
export class OpenAIWorkflowRunner implements WorkflowRunner {
  constructor(readonly provider: OpenAICompatProvider) {}

  async run(prompt: string, schema?: JsonSchema, _label?: string): Promise<RunnerOutput> {
    let request = prompt;
    if (schema !== undefined) {
      request +=
        "\n\nReturn only one JSON object matching this schema:\n" +
        stableStringify(schema);
    }
    const { message, usage } = await this.provider.chatCompletion(
      [
        {
          role: "system",
          content:
            "You are a focused workflow agent. Complete only the supplied step. " +
            "Do not claim access to files or results not included in the prompt.",
        },
        { role: "user", content: request },
      ],
      2000,
    );
    const text = message.content ?? "";
    let value: unknown = text;
    if (schema !== undefined) {
      try {
        value = parseRunnerJson(text);
      } catch (error) {
        if (!(error instanceof WorkflowInputError)) throw error;
        value = text;
      }
    }
    return { value, tokens: usage.promptTokens + usage.completionTokens };
  }
}

/** 确定性 runner,用于单元测试与无 API 场景。 */
export class MockWorkflowRunner implements WorkflowRunner {
  async run(prompt: string, schema?: JsonSchema, label?: string): Promise<RunnerOutput> {
    if (schema === undefined) {
      return { value: `[mock] ${prompt.slice(0, 60)}`, tokens: Math.floor(prompt.length / 4) };
    }
    const props = schema.properties ?? {};
    let value: Record<string, unknown>;
    if ("isReal" in props) {
      value = { isReal: true, reason: "reproduced" };
    } else {
      value = {};
      for (const key of schema.required ?? []) {
        const t = props[key]?.type;
        if (t === "array") value[key] = [];
        else if (t === "boolean") value[key] = Number(stableHash(prompt + key) % 4n) !== 0;
        else if (t === "number" || t === "integer") value[key] = Number(stableHash(prompt + key) % 5n);
        else value[key] = `${label ?? key}-value`;
      }
    }
    return { value, tokens: Math.floor(prompt.length / 4) + 8 };
  }
}

export class Budget {
  private spent = 0;

  constructor(readonly total?: number) {}

  add(n: number): void {
    if (this.total !== undefined && this.spent + n > this.total) {
      throw new WorkflowInputError(`token budget exceeded (${this.spent + n} > ${this.total})`);
    }
    this.spent += n;
  }

  remaining(): number {
    return this.total === undefined ? Infinity : Math.max(0, this.total - this.spent);
  }
}

export class ExecutionLimits {
  agents = 0;
  readonly semaphore = new Semaphore(CONCURRENCY);

  claimAgent(): void {
    this.agents += 1;
    if (this.agents > AGENT_CAP) {
      throw new WorkflowInputError(`agent() cap reached (${AGENT_CAP})`);
    }
  }
}

export class ExecutionState {
  private phase_: string | undefined;
  private readonly phasesSeen = new Set<string>();

  constructor(
    readonly task: WorkflowTaskLike,
    readonly journal: WorkflowJournal,
    readonly runner: WorkflowRunner,
    readonly budget: Budget,
    readonly args: Record<string, unknown>,
    private readonly depth: number = 0,
    readonly limits: ExecutionLimits = new ExecutionLimits(),
    readonly workflows: WorkflowRegistry = new Map(),
  ) {}

  phase(title: string): void {
    this.phase_ = title;
    if (!this.phasesSeen.has(title)) {
      this.phasesSeen.add(title);
      this.task.progressEvent("workflow_phase", { title });
    }
  }

  log(message: string): void {
    this.task.progressEvent("workflow_log", { message });
  }

  async agent(prompt: string, schema?: JsonSchema, label?: string, phase?: string): Promise<unknown> {
    const resolvedLabel = label ?? prompt.slice(0, 24) + "...";
    this.limits.claimAgent();
    if (this.budget.remaining() <= 0) {
      throw new WorkflowInputError("token budget exceeded");
    }
    const key = this.journal.key("agent", resolvedLabel, prompt, schema);
    const cached = this.journal.cached(key);
    if (cached !== MISS) {
      if (schema !== undefined) {
        const [ok, err] = new SimpleJsonSchema(schema).validate(cached);
        if (!ok) {
          throw new WorkflowInputError(`cached agent output failed schema validation: ${err}`);
        }
      }
      this.task.progressEvent("workflow_agent", {
        label: resolvedLabel,
        phase: phase ?? this.phase_,
        status: "cached",
      });
      return cached;
    }
    await this.limits.semaphore.acquire();
    let result: unknown;
    let tokens: number;
    try {
      let run = await this.runner.run(prompt, schema, resolvedLabel);
      result = run.value;
      tokens = run.tokens;
      if (schema !== undefined) {
        let [ok, err] = new SimpleJsonSchema(schema).validate(result);
        if (!ok) {
          const retry = await this.runner.run(prompt + "\n\nReturn valid JSON.", schema, resolvedLabel);
          result = retry.value;
          tokens += retry.tokens;
          [ok, err] = new SimpleJsonSchema(schema).validate(result);
          if (!ok) {
            throw new WorkflowInputError(`agent({schema}) invalid output: ${err}`);
          }
        }
      }
    } finally {
      this.limits.semaphore.release();
    }
    this.budget.add(tokens);
    this.task.usage.agents += 1;
    this.task.usage.tokens += tokens;
    this.journal.record(key, result);
    this.task.progressEvent("workflow_agent", {
      label: resolvedLabel,
      phase: phase ?? this.phase_,
      status: "done",
    });
    return result;
  }

  async parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]> {
    return Promise.all(thunks.map((thunk) => thunk()));
  }

  async pipeline(
    items: unknown[],
    ...stages: Array<(value: unknown, item: unknown, idx: number) => Promise<unknown>>
  ): Promise<unknown[]> {
    const runItem = async (item: unknown, idx: number): Promise<unknown> => {
      let value = item;
      for (const stage of stages) value = await stage(value, item, idx);
      return value;
    };
    return Promise.all(items.map((it, i) => runItem(it, i)));
  }

  async workflow(name: string, args?: Record<string, unknown>): Promise<unknown> {
    if (this.depth >= 1) throw new WorkflowInputError("workflow() nesting is one level only");
    const entry = this.workflows.get(name);
    if (entry === undefined) throw new WorkflowInputError(`unknown workflow '${name}'`);
    const [, fn] = entry;
    const child = new ExecutionState(
      this.task,
      this.journal,
      this.runner,
      this.budget,
      args ?? {},
      this.depth + 1,
      this.limits,
      this.workflows,
    );
    return fn(child, args ?? {});
  }
}
