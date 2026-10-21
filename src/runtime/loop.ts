import type {
  ChatMessage,
  ChatProvider,
  ChatUsage,
  ToolCall,
  ToolDefinition,
} from "../contracts/types.js";
import { isPromptTooLong } from "../contracts/provider-errors.js";
import { summarize } from "../contracts/text.js";
import { estimatePromptTokens, estimateTextTokens, TokenEstimator } from "../contracts/estimate.js";
import type { StopDecision } from "../contracts/goals.js";
import type { EventBus } from "./events.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "../contracts/hooks.js";
import { createLogger } from "@blh/logger";
import { classifyToolOutcome, TOOL_ERROR_PREFIX } from "@blh/web-protocol";
import { parseToolArguments } from "./parse-args.js";
import type { AgentLoopRuntime, CompactionPlan, GoalEvaluationPort } from "./ports.js";
import type { Transcript } from "../session/transcript.js";
import { sanitizeReplay } from "../session/sanitize.js";

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

/** 一次工具调用的请求：模型返回的原始调用信息，加上解析后的参数。 */
export interface AgentLoopToolRequest {
  /** 模型返回的原始工具调用（含调用 id、函数名、参数 JSON 串）。 */
  call: ToolCall;
  /** 解析后的工具参数（调用 id、函数名、参数 JSON 串去解析后得到）。 */
  input: Record<string, unknown>;
}

/** 工具分发器：注入后可自定义「如何执行某个工具」，返回执行结果文本。 */
export type AgentLoopToolDispatcher = (
  request: AgentLoopToolRequest,
  signal?: AbortSignal,
) => Promise<string>;

/** agent 主循环的运行时配置，可覆盖默认行为。 */
export interface AgentLoopProfile {
  /** 最大迭代轮数；达到后本轮以 max_turns 状态结束。 */
  maxTurns?: number;
  /** 自定义工具分发器；不传则走默认的工具注册表分发。 */
  dispatchTool?: AgentLoopToolDispatcher;
}

/** agent 主循环跑完一轮后的结果。 */
export interface AgentLoopResult {
  /** 结束状态：正常完成 / 被用户中断 / 达到最大轮数。 */
  status: "completed" | "cancelled" | "max_turns";
  /** 实际执行的迭代次数。 */
  iterations: number;
  /** 最后一条 assistant 消息；可能为 null。 */
  finalAssistant: ChatMessage | null;
}

/** 提示词过长时，允许「被动压缩后重试」的最大次数。 */
const MAX_REACTIVE_RETRIES = 1;

/** 组合根未注入窗口/输出上限时的保守兜底（子 agent / 队友走这里）。 */
const FALLBACK_CONTEXT_WINDOW = 8192;
const FALLBACK_MAX_OUTPUT_TOKENS = 4096;
/** 留给回答的余量：window - prompt - SAFETY_BUFFER_TOKENS 即 answerLimit 上限。 */
const SAFETY_BUFFER_TOKENS = 1024;
/** answerLimit 低于此值视为预算被压到底（正常路径不该发生），仅告警。 */
const MIN_ANSWER_TOKENS = 256;

/** 进程内校准器：按模型记录 actual/estimated 的历史最大比例（单调不减）。 */
const tokenEstimator = new TokenEstimator();

/** prompt 可占用的 token 预算 = 窗口 - 输出上限 - 安全余量。 */
function computePromptBudget(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(0, contextWindow - maxOutputTokens - SAFETY_BUFFER_TOKENS);
}

/** answer 上限 = min(输出上限, 窗口 - prompt - 安全余量)，恒 ≥ 1。 */
function computeAnswerLimit(contextWindow: number, maxOutputTokens: number, promptTokens: number): number {
  return Math.max(1, Math.min(maxOutputTokens, contextWindow - promptTokens - SAFETY_BUFFER_TOKENS));
}

/** 响应是否被截断：openai 的 length / anthropic 的 max_tokens。 */
function isTruncated(message: ChatMessage): boolean {
  return message.finishReason === "length" || message.finishReason === "max_tokens";
}

/** 若有 system 消息，则把它拼到消息列表最前面；无则原样返回。用于构造模型输入。 */
function withSystem(
  messages: readonly ChatMessage[],
  system: ChatMessage | null,
): readonly ChatMessage[] {
  if (system === null) return messages;
  return [system, ...messages];
}

/** 把压缩摘要（transcript 元数据）拼进 system 的 [Archived Context Summary] 段（Z）。 */
function injectArchivedSummary(messages: readonly ChatMessage[], summaryText: string | null): ChatMessage[] {
  if (summaryText === null) return [...messages];
  const section = `[Archived Context Summary]\n\n${summaryText}`;
  if (messages[0]?.role === "system") {
    const system = messages[0];
    const base = system.content ?? "";
    return [{ ...system, content: base === "" ? section : `${base}\n\n---\n\n${section}` }, ...messages.slice(1)];
  }
  return [{ role: "system", content: section }, ...messages];
}

/** 从后往前找最后一条 assistant 消息，找不到返回 null。用于确定本轮最终回复。 */
function lastAssistantMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return message;
  }
  return null;
}

/** 按压缩计划压缩对话：保留 firstKeptIndex 之后的消息，之前的用摘要消息替代。 */
function compactTranscript(transcript: Transcript, plan: CompactionPlan): void {
  const firstKeptSeq =
    plan.firstKeptIndex === null
      ? null
      : transcript.messageSeqAt(plan.firstKeptIndex);
  const firstKeptUserSeq =
    plan.firstKeptUserIndex === null
      ? null
      : transcript.messageSeqAt(plan.firstKeptUserIndex);
  transcript.compact(plan.summary, firstKeptSeq, firstKeptUserSeq);
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
  // 流式失败时保留的半成品文字，用于彻底失败时落盘，避免白写内容丢失。
  let streamPartial = "";
  const contextWindow = harness.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  const maxOutputTokens = harness.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
  const promptBudget = computePromptBudget(contextWindow, maxOutputTokens);
  const model = harness.config.model;

  if (events !== undefined) await events.emit({ type: "turn_start" });
  harness.tracer?.beginTurn(activeRequest);
  try {
    for (;;) {
      // 每轮重算压缩预算：transcript.summary 会随压缩增长，必须用最新值（F3）。
      // compactor 用原始估算（estimateContextTokens），预算换算到原始尺度，保证 raw × ratio ≤ promptBudget。
      const summaryTokens = transcript.summary !== null ? estimateTextTokens(transcript.summary) : 0;
      const compactorBudget = Math.max(0, Math.floor(promptBudget / tokenEstimator.ratio(model)) - summaryTokens);
      // 摘要后保留的最近 user 原文 token 预算（原始估算尺度，与 compactor 一致）。
      const userRetentionTokens = Math.min(20000, Math.floor(compactorBudget / 4));

      // 第 1 步：检查中断信号与最大轮数上限。
      if (signal?.aborted) {
        return cancelTurnAborted(harness, transcript, events, iterations);
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

      log.debug("turn start", { messages: transcript.messageCount });

      // 第 2 步：把已完成的后台任务结果注入对话。
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

      // 第 3 步：准备模型输入（有压缩器时先尝试压缩）。
      const compactor = harness.compactor;
      if (compactor) {
        const prepared = await compactor.prepare(transcript.conversation, activeRequest, compactorBudget, userRetentionTokens, transcript.summary);
        if (prepared.compaction) {
          compactTranscript(transcript, prepared.compaction);
          modelMessages = transcript.messages;
        } else {
          modelMessages = withSystem(prepared.messages, transcript.systemMessage);
        }
      } else {
        modelMessages = transcript.messages;
      }

      // 第 4 步：调用模型生成回复（优先流式，失败回退非流式）。
      const tools = harness.tools.list();
      // 先把压缩摘要从对话移进 system（C4a），再做 replay 前清洗（R5）。
      const requestMessages = sanitizeReplay(injectArchivedSummary(modelMessages, transcript.summary));
      const rawPromptTokens = estimatePromptTokens(requestMessages, tools);
      const estimatedPromptTokens = tokenEstimator.scale(model, rawPromptTokens);
      const answerLimit = computeAnswerLimit(contextWindow, maxOutputTokens, estimatedPromptTokens);
      if (answerLimit < MIN_ANSWER_TOKENS) {
        log.warn("answer limit starved", { model, answerLimit, estimatedPromptTokens, contextWindow });
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
              requestMessages,
              tools,
              events,
              signal,
              answerLimit,
            );
            message = streamed.message;
            usage = streamed.usage;
            usedStream = true;
          } catch (error) {
            if (error instanceof TurnCancelledError) throw error;
            let partialText = error instanceof StreamFailedError ? error.partialText : "";
            streamPartial = partialText;
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
            // 流在输出任何文本前就失败：退避后重试一次流式（UI 尚无半截内容，重试无副作用）。
            if (partialText === "" && signal?.aborted === false) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              try {
                const retried = await streamAssistantMessage(
                  harness.provider,
                  requestMessages,
                  tools,
                  events,
                  signal,
                  answerLimit,
                );
                message = retried.message;
                usage = retried.usage;
                usedStream = true;
              } catch (retryError) {
                if (retryError instanceof TurnCancelledError) throw retryError;
                partialText = retryError instanceof StreamFailedError ? retryError.partialText : "";
                streamPartial = partialText;
                const response = await requestAssistantMessageComplete(
                  harness.provider,
                  requestMessages,
                  tools,
                  events,
                  signal,
                  partialText,
                  answerLimit,
                );
                message = response.message;
                usage = response.usage;
              }
            } else {
              const response = await requestAssistantMessageComplete(
                harness.provider,
                requestMessages,
                tools,
                events,
                signal,
                partialText,
                answerLimit,
              );
              message = response.message;
              usage = response.usage;
            }
          }
        } else {
          const response = await requestAssistantMessage(
            harness.provider,
            requestMessages,
            tools,
            signal,
            answerLimit,
          );
          message = response.message;
          usage = response.usage;
        }

        iterations += 1;
        if (usage !== null && usage.promptTokens > 0) {
          tokenEstimator.observe(model, rawPromptTokens, usage.promptTokens);
        }
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
          const compacted = await compactor.reactiveCompact(transcript.conversation, activeRequest, userRetentionTokens, transcript.summary);
          if (compacted.compaction) {
            compactTranscript(transcript, compacted.compaction);
            modelMessages = transcript.messages;
          } else {
            modelMessages = withSystem(compacted.messages, transcript.systemMessage);
          }
          reactiveRetries += 1;
          continue;
        }
        // 流式与非流式都失败：保留已生成的半成品文字，标为 cancelled，避免白写内容丢失。
        if (streamPartial !== "") {
          transcript.append({ role: "assistant", content: streamPartial, cancelled: true });
        }
        throw error;
      }

      // R3(b)：响应被截断且带 tool_calls 时，残缺调用不可执行；落盘半成品（不带 tool_calls）并结束本轮。
      if (isTruncated(message) && (message.tool_calls?.length ?? 0) > 0) {
        log.warn("truncated tool call response discarded", { model, finishReason: message.finishReason });
        const partial: ChatMessage = { role: "assistant", content: message.content, cancelled: true };
        transcript.append(partial);
        harness.tracer?.endTurn("truncated");
        if (events !== undefined) await events.emit({ type: "turn_end" });
        return { status: "completed", iterations, finalAssistant: partial };
      }

      transcript.append(message);
      modelMessages = transcript.messages;
      const toolCalls: ToolCall[] = message.tool_calls ?? [];

      // 第 5 步：没有工具调用时，做目标检查，达标则结束本轮。
      if (toolCalls.length === 0) {
        const decision = await evaluateGoalStop(harness, modelMessages);
        if (decision !== null && decision.action !== "allow") {
          harness.tracer?.event("goal", {
            action: decision.action,
            reason: summarize(decision.reason),
          });
        }
        if (decision !== null && decision.action === "block") {
          transcript.append({ role: "user", content: goalReminder(harness.goal, decision), isInternal: true });
          continue;
        }
        harness.tracer?.endTurn();
        if (events !== undefined) await events.emit({ type: "turn_end" });
        return { status: "completed", iterations, finalAssistant: message };
      }

      // 第 6 步：逐个执行工具调用，并把结果写回对话。
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
              result = `${TOOL_ERROR_PREFIX} ${error instanceof Error ? error.message : String(error)}`;
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
        }

        if (name === "todo_write") usedTodo = true;

        const outcome = classifyToolOutcome(result);
        const isError = outcome === "error";
        const isDenied = outcome === "denied";

        if (events !== undefined) {
          await events.emit({
            type: "tool_result",
            id: call.id,
            name,
            output: result,
            isError: isError || isDenied,
          });
        }
        harness.tracer?.event("tool", {
          tool: name,
          args_summary: summarize(JSON.stringify(input)),
          latency_ms: Date.now() - toolStart,
          status: isError
            ? "error"
            : isDenied
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

      // 第 7 步：工具执行后的收尾——中断检查、todo 提醒、主动压缩。
      if (signal?.aborted) {
        return cancelTurnAborted(harness, transcript, events, iterations);
      }

      const todoManager = harness.todoManager;
      if (todoManager) {
        const reminder = todoManager.noteRound(usedTodo);
        if (reminder) transcript.append({ role: "user", content: reminder, isInternal: true });
      }

      if (compactRequested && compactor) {
        const compacted = await compactor.compactHistory(transcript.conversation, activeRequest, userRetentionTokens, transcript.summary);
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

async function cancelTurnAborted(
  harness: AgentLoopRuntime,
  transcript: Transcript,
  events: EventBus | undefined,
  iterations: number,
): Promise<AgentLoopResult> {
  cancelLatestAssistant(transcript);
  harness.tracer?.cancelTurn("aborted");
  if (events !== undefined) await events.emit({ type: "turn_cancelled", text: "" });
  return {
    status: "cancelled",
    iterations,
    finalAssistant: lastAssistantMessage(transcript.messages),
  };
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
  maxTokens?: number,
): Promise<{ message: ChatMessage; usage: ChatUsage | null }> {
  const stream = provider.stream!(messages, tools, maxTokens, signal);
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

/** 非流式请求一条 assistant 消息；provider 支持返回用量时用 chatWithUsage，否则退回 chat 并补 usage: null。 */
async function requestAssistantMessage(
  provider: ChatProvider,
  messages: readonly ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<{ message: ChatMessage; usage: ChatUsage | null }> {
  if (provider.chatWithUsage !== undefined) {
    return provider.chatWithUsage(messages, tools, maxTokens, signal);
  }
  const message = await provider.chat(messages, tools, maxTokens, signal);
  return { message, usage: null };
}

/**
 * 流式失败后的非流式兜底：拿到完整回复后，用 assistant_text_complete 事件让 UI
 * 用完整文本整体替换之前已展示的半截内容，而不是拼接/补后缀。
 */
async function requestAssistantMessageComplete(
  provider: ChatProvider,
  messages: readonly ChatMessage[],
  tools: ToolDefinition[],
  events: EventBus,
  signal: AbortSignal | undefined,
  partialText: string,
  maxTokens?: number,
): Promise<{ message: ChatMessage; usage: ChatUsage | null }> {
  const response = await requestAssistantMessage(provider, messages, tools, signal, maxTokens);
  const completeText = response.message.content ?? "";
  // 有完整文本要替换，或之前展示过半截需要清空时，才发替换事件。
  if (partialText !== "" || completeText !== "") {
    await events.emit({ type: "assistant_text_complete", text: completeText });
  }
  return response;
}
