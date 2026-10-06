import type { HookBus } from "../runtime/hooks.js";
import type { ChatProvider, Config } from "../contracts/types.js";
import { runAgentLoop } from "../runtime/loop.js";
import type { AgentLoopRuntime } from "../runtime/ports.js";
import { registerBuiltinTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { summarize, type Tracer } from "../tracing/tracer.js";
import { Transcript } from "../session/transcript.js";

const SUB_SYSTEM =
  "你是一个编程智能体。完成给定的任务，然后返回一个简洁的最终回答。";
const MAX_SUBAGENT_TURNS = 30;

/** 一次性嵌套 Agent Loop：新鲜 messages、无 task 工具、最多 30 轮，只返回最终文本。 */
export class SubagentRunner {
  readonly tools = new ToolRegistry();

  /**
   * 创建子智能体运行器。
   * provider 用来调模型，config 是全局配置，hooks 用来做工具执行前/后的权限拦截和回调。
   */
  constructor(
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
    readonly tracer?: Tracer,
  ) {
    registerBuiltinTools(this.tools, config);
  }

  /**
   * 跑一个一次性的子智能体任务：
   * 用全新的消息列表、只带内置工具，最多循环 30 轮，直到模型不再调用工具，返回最终文本。
   * 超过 30 轮还没结束，就返回一条提示说明。
   */
  async run(prompt: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return "Subagent cancelled.";
    const start = Date.now();
    const tracer = this.tracer?.scoped("subagent");
    tracer?.event("subagent", { name: "subagent", status: "spawn", task: summarize(prompt, 200) });
    const transcript = new Transcript({ system: { role: "system", content: SUB_SYSTEM } });
    transcript.append({ role: "user", content: prompt });
    const runtime: AgentLoopRuntime = {
      systemPrompt: SUB_SYSTEM,
      config: this.config,
      provider: this.provider,
      tools: this.tools,
      hooks: this.hooks,
      tracer,
    };
    try {
      const result = await runAgentLoop(
        runtime,
        transcript,
        prompt,
        undefined,
        signal,
        { maxTurns: MAX_SUBAGENT_TURNS },
      );
      if (result.status === "cancelled") return "Subagent cancelled.";
      if (result.status === "max_turns") {
        tracer?.event("subagent", {
          name: "subagent",
          status: "result",
          latency_ms: Date.now() - start,
        });
        return `Subagent stopped after ${MAX_SUBAGENT_TURNS} turns without a final answer.`;
      }
      tracer?.event("subagent", { name: "subagent", status: "result", latency_ms: Date.now() - start });
      return result.finalAssistant?.content || "(no summary)";
    } catch (error) {
      if (signal?.aborted) return "Subagent cancelled.";
      throw error;
    }
  }
}
