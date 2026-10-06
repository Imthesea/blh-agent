import type {
  ChatMessage,
  ChatProvider,
  ChatUsage,
  ToolCall,
  ToolDefinition,
} from "../contracts/types.js";
import { isPromptTooLong } from "../contracts/provider-errors.js";
import { summarize } from "../contracts/text.js";
import type { StopDecision } from "../contracts/goals.js";
import type { EventBus } from "./events.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "../contracts/hooks.js";
import { createLogger } from "@blh/logger";
import { parseToolArguments } from "./parse-args.js";
import type { AgentLoopRuntime, CompactionPlan, GoalEvaluationPort } from "./ports.js";
import type { Transcript } from "../session/transcript.js";

const log = createLogger("runtime.loop");

/** 用户主动中断当前轮时抛出，携带已生成的半成品文字。 */
export class TurnCancelledError extends Error {
  constructor(readonly partialText: string) {
    super("turn cancelled");
    this.name = "TurnCancelledError";
  }
}

class StreamFailedError extends Error {
  constructor(readonly partialText: string, cause?: unknown) {
    super(
      `provider stream failed: ${
        cause instanceof Error ? cause.message : cause === undefined ? "unknown error" : String(cause)
      }`,
    );
    this.name = "StreamFailedError";
  }
}

export interface AgentLoopToolRequest {
  call: ToolCall;
  input: Record<string, unknown>;
}

export type AgentLoopToolDispatcher = (
  request: AgentLoopToolRequest,
  signal?: AbortSignal,
) => Promise<string>;

export interface AgentLoopProfile {
  maxTurns?: number;
  dispatchTool?: AgentLoopToolDispatcher;
}

export interface AgentLoopResult {
  status: "completed" | "cancelled" | "max_turns";
  iterations: number;
  finalAssistant: ChatMessage | null;
}

export { parseToolArguments };

/** 提示词过长时，允许「被动压缩后重试」的最大次数。 */
const MAX_REACTIVE_RETRIES = 1;

function withSystem(
  messages: readonly ChatMessage[],
  system: ChatMessage | null,
): readonly ChatMessage[] {
  if (system === null) return messages;
  return [system, ...messages];
}

function lastAssistantMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return message;
  }
  return null;
}

function compactTranscript(transcript: Transcript, plan: CompactionPlan): void {
  const firstKeptSeq =
    plan.firstKeptIndex === null
      ? null
      : transcript.messageSeqAt(plan.firstKeptIndex);
  transcript.compact(plan.summaryMessage, firstKeptSeq);
}

/** 核心对话循环。事实状态只能通过 Transcript 事件提交；模型输入是本轮投影。 */
export async function runAgentLoop(
  harness: AgentLoopRuntime,
  transcript: Transcript,
  activeRequest = "",
  events?: EventBus,
  signal?: AbortSignal,
  profile: AgentLoopProfile = {},
): Promise<AgentLoopResult> {
  let reactiveRetries = 0;
  let iterations = 0;
  let modelMessages: readonly ChatMessage[] = transcript.messages;

  if (events !== undefined) await events.emit({ type: "turn_start" });
  harness.tracer?.beginTurn(activeRequest);
  try {
    for (;;) {
      if (signal?.aborted) {
        cancelLatestAssistant(transcript);
        harness.tracer?.cancelTurn("aborted");
        if (events !== undefined) await events.emit({ type: "turn_cancelled", text: "" });
        return {
          status: "cancelled",
          iterations,
          finalAssistant: lastAssistantMessage(transcript.messages),
        };
      }
      if (profile.maxTurns !== undefined && iterations >= profile.maxTurns) {
        harness.tracer?.endTurn("max_turns");
        if (events !== undefined) await events.emit({ type: "turn_end" });
        return {
          status: "max_turns",
          iterations,
          finalAssistant: lastAssistantMessage(transcript.messages),
        };
      }

      log.debug("turn start", { messages: transcript.messages.length });
      const compactor = harness.compactor;

      if (harness.jobs) {
        const injected = harness.jobs.injectBackgroundResults(transcript);
        if (injected > 0) {
          harness.tracer?.event("job", {
            kind: "background",
            name: "collect",
            status: "completed",
            count: injected,
          });
        }
      }

      if (compactor) {
        const prepared = await compactor.prepare(transcript.messages, activeRequest);
        if (prepared.compaction) {
          compactTranscript(transcript, prepared.compaction);
          modelMessages = transcript.messages;
        } else {
          modelMessages = withSystem(prepared.messages, transcript.systemMessage);
        }
      } else {
        modelMessages = transcript.messages;
      }

      let message: ChatMessage;
      const streamAvailable = events !== undefined && harness.provider.stream !== undefined;
      let usage: ChatUsage | null = null;
      let usedStream = false;
      const llmStart = Date.now();
      try {
        if (streamAvailable) {
          try {
            const streamed = await streamAssistantMessage(
              harness.provider,
              modelMessages,
              harness.tools.list(),
              events,
              signal,
            );
            message = streamed.message;
            usage = streamed.usage;
            usedStream = true;
          } catch (error) {
            if (error instanceof TurnCancelledError) throw error;
            const partialText = error instanceof StreamFailedError ? error.partialText : "";
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
            const response = await requestAssistantMessage(
              harness.provider,
              modelMessages,
              harness.tools.list(),
              signal,
            );
            message = response.message;
            usage = response.usage;
            await emitRecoveredStreamText(events, partialText, message);
          }
        } else {
          const response = await requestAssistantMessage(
            harness.provider,
            modelMessages,
            harness.tools.list(),
            signal,
          );
          message = response.message;
          usage = response.usage;
        }

        iterations += 1;
        harness.tracer?.event("llm", {
          provider: harness.config.provider ?? "deepseek",
          model: harness.config.model,
          stream: usedStream,
          status: "ok",
          stop_reason:
            message.tool_calls !== undefined && message.tool_calls.length > 0
              ? "tool_calls"
              : "stop",
          latency_ms: Date.now() - llmStart,
          retries: reactiveRetries,
          usage,
        });
        reactiveRetries = 0;
      } catch (error) {
        if (error instanceof TurnCancelledError) {
          const partial: ChatMessage = {
            role: "assistant",
            content: error.partialText,
            cancelled: true,
          };
          transcript.append(partial);
          harness.tracer?.cancelTurn("cancelled");
          if (events !== undefined) {
            await events.emit({ type: "turn_cancelled", text: error.partialText });
          }
          return { status: "cancelled", iterations, finalAssistant: partial };
        }
        if (signal?.aborted) {
          const partial: ChatMessage = { role: "assistant", content: "", cancelled: true };
          transcript.append(partial);
          harness.tracer?.cancelTurn("aborted");
          if (events !== undefined) {
            await events.emit({ type: "turn_cancelled", text: "" });
          }
          return { status: "cancelled", iterations, finalAssistant: partial };
        }

        if (compactor && isPromptTooLong(error) && reactiveRetries < MAX_REACTIVE_RETRIES) {
          const compacted = await compactor.reactiveCompact(transcript.messages, activeRequest);
          if (compacted.compaction) {
            compactTranscript(transcript, compacted.compaction);
            modelMessages = transcript.messages;
          } else {
            modelMessages = withSystem(compacted.messages, transcript.systemMessage);
          }
          reactiveRetries += 1;
          continue;
        }
        throw error;
      }

      transcript.append(message);
      modelMessages = transcript.messages;
      const toolCalls: ToolCall[] = message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        const decision = await evaluateGoalStop(harness, transcript.messages);
        if (decision !== null && decision.action !== "allow") {
          harness.tracer?.event("goal", {
            action: decision.action,
            reason: summarize(decision.reason),
          });
        }
        if (decision !== null && decision.action === "block") {
          transcript.append({ role: "user", content: goalReminder(harness.goal, decision) });
          continue;
        }
        harness.tracer?.endTurn();
        if (events !== undefined) await events.emit({ type: "turn_end" });
        return { status: "completed", iterations, finalAssistant: message };
      }

      let compactRequested = false;
      let usedTodo = false;
      for (const call of toolCalls) {
        const name = call.function.name;
        const toolStart = Date.now();
        log.debug("tool call", { tool: name });
        const input = parseToolArguments(call.function.arguments);
        const background =
          harness.jobs !== undefined &&
          name === "bash" &&
          input["run_in_background"] === true;

        if (events !== undefined) {
          await events.emit({
            type: "tool_call",
            id: call.id,
            name,
            arguments: call.function.arguments,
          });
        }

        let result: string;
        if (profile.dispatchTool !== undefined) {
          result = await profile.dispatchTool({ call, input }, signal);
        } else if (compactor && name === "compact") {
          result = "Compaction requested after this tool batch.";
          compactRequested = true;
        } else if (background) {
          const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
          if (blocked !== null) {
            result = blocked;
          } else {
            try {
              result = harness.jobs!.startBackground(String(input["command"] ?? ""));
              harness.tracer?.event("job", {
                kind: "background",
                name: summarize(String(input["command"] ?? ""), 100),
                status: "started",
              });
            } catch (error) {
              result = `error: ${error instanceof Error ? error.message : String(error)}`;
            }
            await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
          }
        } else {
          const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
          if (blocked !== null) {
            result = blocked;
          } else {
            result = await harness.tools.dispatch(name, input, signal);
            await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
          }
          if (name === "todo_write") usedTodo = true;
        }

        if (events !== undefined) {
          await events.emit({
            type: "tool_result",
            id: call.id,
            name,
            output: result,
            isError: result.startsWith("error:") || result.startsWith("denied"),
          });
        }
        harness.tracer?.event("tool", {
          tool: name,
          args_summary: summarize(JSON.stringify(input)),
          latency_ms: Date.now() - toolStart,
          status: result.startsWith("error:")
            ? "error"
            : result.startsWith("denied")
              ? "denied"
              : "ok",
          output_summary: summarize(result),
          ...(background ? { background: true } : {}),
        });
        transcript.append({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }

      if (signal?.aborted) {
        cancelLatestAssistant(transcript);
        harness.tracer?.cancelTurn("aborted");
        if (events !== undefined) {
          await events.emit({ type: "turn_cancelled", text: "" });
        }
        return {
          status: "cancelled",
          iterations,
          finalAssistant: lastAssistantMessage(transcript.messages),
        };
      }

      const todoManager = harness.todoManager;
      if (todoManager) {
        const reminder = todoManager.noteRound(usedTodo);
        if (reminder) transcript.append({ role: "user", content: reminder });
      }

      if (compactRequested && compactor) {
        const compacted = await compactor.compactHistory(transcript.messages, activeRequest);
        if (compacted.compaction) {
          compactTranscript(transcript, compacted.compaction);
          modelMessages = transcript.messages;
        }
      }
    }
  } catch (error) {
    harness.tracer?.cancelTurn("error");
    throw error;
  }
}

export async function agentLoop(
  harness: AgentLoopRuntime,
  transcript: Transcript,
  activeRequest = "",
  events?: EventBus,
  signal?: AbortSignal,
  profile: AgentLoopProfile = {},
): Promise<void> {
  await runAgentLoop(harness, transcript, activeRequest, events, signal, profile);
}

function cancelLatestAssistant(transcript: Transcript): void {
  const seq = transcript.lastAssistantSeqAfter(0);
  if (seq !== null) transcript.cancelMessage(seq);
}

async function evaluateGoalStop(
  harness: AgentLoopRuntime,
  messages: readonly ChatMessage[],
): Promise<StopDecision | null> {
  const goal = harness.goal;
  if (goal === undefined) return null;
  const backgroundRunning = harness.jobs !== undefined && harness.jobs.background.hasRunning();
  return goal.evaluateAfterTurn(messages, backgroundRunning);
}

function goalReminder(goal: GoalEvaluationPort | undefined, decision: StopDecision): string {
  const condition = goal?.active?.condition ?? "";
  return (
    `[Goal still active]\nCondition: ${condition}\n` +
    `Evaluator: ${decision.reason}\n` +
    "Continue working and surface the missing evidence."
  );
}

async function streamAssistantMessage(
  provider: ChatProvider,
  messages: readonly ChatMessage[],
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
    throw new StreamFailedError(partialText, error);
  }
  throw new StreamFailedError(
    partialText,
    new Error("provider stream ended without a done event"),
  );
}

async function requestAssistantMessage(
  provider: ChatProvider,
  messages: readonly ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ message: ChatMessage; usage: ChatUsage | null }> {
  if (provider.chatWithUsage !== undefined) {
    return provider.chatWithUsage(messages, tools, undefined, signal);
  }
  const message = await provider.chat(messages, tools, undefined, signal);
  return { message, usage: null };
}

async function emitRecoveredStreamText(
  events: EventBus,
  partialText: string,
  message: ChatMessage,
): Promise<void> {
  if (partialText === "") return;
  const completeText = message.content ?? "";
  if (completeText.startsWith(partialText)) {
    const suffix = completeText.slice(partialText.length);
    if (suffix !== "") await events.emit({ type: "assistant_text_delta", text: suffix });
    return;
  }
  if (completeText !== "") {
    await events.emit({
      type: "assistant_text_delta",
      text: `\n\n[stream recovered; full response]\n${completeText}`,
    });
    return;
  }
  await events.emit({
    type: "assistant_text_delta",
    text: "\n\n[stream recovered; previous partial text may be incomplete]",
  });
}
