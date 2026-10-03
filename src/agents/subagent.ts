import { POST_TOOL_USE, PRE_TOOL_USE } from "../core/hooks.js";
import type { HookBus } from "../core/hooks.js";
import { parseToolArguments } from "../core/parse-args.js";
import type { ChatMessage, ChatProvider, Config, ToolCall } from "../core/types.js";
import { registerBuiltinTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { summarize, type Tracer } from "../tracing/tracer.js";

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
    const start = Date.now();
    this.tracer?.event("subagent", { name: "subagent", status: "spawn", task: summarize(prompt, 200) });
    const messages: ChatMessage[] = [
      { role: "system", content: SUB_SYSTEM },
      { role: "user", content: prompt },
    ];
    try {
      for (let turn = 0; turn < MAX_SUBAGENT_TURNS; turn++) {
        if (signal?.aborted) return "Subagent cancelled.";
        const assistant = await this.provider.chat(messages, this.tools.list(), undefined, signal);
        messages.push(assistant);
        const toolCalls: ToolCall[] = assistant.tool_calls ?? [];
        if (toolCalls.length === 0) {
          this.tracer?.event("subagent", { name: "subagent", status: "result", latency_ms: Date.now() - start });
          return assistant.content || "(no summary)";
        }
        for (const call of toolCalls) {
          if (signal?.aborted) return "Subagent cancelled.";
          const name = call.function.name;
          const input = parseToolArguments(call.function.arguments);
          const blocked = await this.hooks.firstBlock(PRE_TOOL_USE, { name, input });
          let result: string;
          if (blocked !== null) {
            result = blocked;
          } else {
            result = await this.tools.dispatch(name, input, signal);
            await this.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }
    } catch (error) {
      if (signal?.aborted) return "Subagent cancelled.";
      throw error;
    }
    this.tracer?.event("subagent", { name: "subagent", status: "result", latency_ms: Date.now() - start });
    return "Subagent stopped after 30 turns without a final answer.";
  }
}
