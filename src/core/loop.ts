import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition } from "./types.js";
import type { Harness } from "./harness.js";
import type { EventBus } from "./events.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "./hooks.js";
import { isPromptTooLong } from "../providers/openai.js";
import type { GoalController } from "../goals/controller.js";
import type { StopDecision } from "../goals/types.js";
import { createLogger } from "@blh/logger";
import { parseToolArguments } from "./parse-args.js";

const log = createLogger("core.loop");

export { parseToolArguments };

/** 提示词过长时，允许「被动压缩后重试」的最大次数 */
const MAX_REACTIVE_RETRIES = 1;

/** 从后往前找最后一条 assistant 消息，返回它的文本内容；没有则返回空串 */
export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content) return message.content;
  }
  return "";
}

/**
 * 核心对话循环：反复调用模型，直到模型不再要求调用工具为止。
 * 每轮先压缩历史、注入后台任务结果，再请求模型；
 * 模型返回工具调用则逐个执行，否则评估目标是否满足后决定继续还是结束。
 * 1. 每一轮开始前，先把太长的聊天记录压缩一下（省 token）。
 * 2. 看看有没有后台任务跑完了，把结果塞进对话里。
 * 3. 调用模型，拿到它的回复。
 * 4. 如果模型说要调用工具（比如读写文件、执行命令），就一个一个执行，然后把结果再喂回给模型，进入下一轮。
 * 5. 如果模型不再调用工具了，就检查一下「目标」有没有达成；没达成就提醒模型继续干，达成了就结束循环。
 *
 * 参数含义：
 * - harness：各种功能的集合体（工具、压缩器、后台任务、钩子、目标控制器等），相当于一个「工具箱」。
 * - messages：当前对话的完整消息列表，这个方法会直接往里面追加消息，所以是「就地修改」。
 * - activeRequest：用户当前这条请求的原文，主要给压缩器做参照。
 * - events：可选的事件总线，用来向外广播「每一轮开始/结束、工具调用」等过程事件，方便前端展示。
 */
export async function agentLoop(
  harness: Harness,
  messages: ChatMessage[],
  activeRequest = "",
  events?: EventBus,
): Promise<void> {
  // 系统消息（system）通常放在消息列表第一项，用来设定 AI 的角色和规则。
  // 如果第一项不是 system，就用 harness 里预设好的系统提示词兜底，保证后面压缩历史时能把它找回来。
  const systemMessage: ChatMessage =
    messages[0] ?? { role: "system", content: harness.systemPrompt };
  // 记录「因为提示词太长而被动压缩重试」的次数，用来防止死循环（最多重试一次）。
  let reactiveRetries = 0;
  // 广播「这一轮对话开始」的事件。
  await events?.emit({ type: "turn_start" });
  // 一个死循环，靠内部的 return 来退出（模型不再调用工具且目标达成时退出）。
  for (;;) {
    log.debug("turn start", { messages: messages.length });
    const compactor = harness.compactor;
    // 如果配置了压缩器，每轮开始前先「整理」一遍历史消息。
    // prepare 会返回一份新的消息数组，再用 splice 原地替换掉 messages 的内容。
    if (compactor) {
      const prepared = await compactor.prepare(messages, activeRequest);
      messages.splice(0, messages.length, ...prepared);
      // 压缩/摘要可能会把 system 消息丢掉，这里再把它挂回队首。
      restoreSystem(messages, systemMessage);
    }
    // 如果配置了后台任务管理器，把已经跑完的后台任务结果注入到对话里，让模型能看到进展。
    if (harness.jobs) {
      harness.jobs.injectBackgroundResults(messages);
    }
    let message: ChatMessage;
    // 判断能不能用「流式输出」：既要传了事件总线，也要 provider 本身支持 stream。
    // 流式输出 = 模型一个字一个字地吐，前端能实时看到；非流式 = 等整段回复生成完再一次性返回。
    const streamAvailable = events !== undefined && harness.provider.stream !== undefined;
    try {
      if (streamAvailable) {
        // 走流式输出，边生成边把文字增量广播出去。
        try {
          message = await streamAssistantMessage(harness.provider, messages, harness.tools.list(), events);
        } catch (error) {
          // 流式偶尔会失败，这里退回到非流式方式再试一次，保证对话不中断。
          log.warn("stream failed, falling back to non-streaming", {
            error: error instanceof Error ? error.message : String(error),
          });
          message = await harness.provider.chat(messages, harness.tools.list());
        }
      } else {
        // 不支持流式就直接用普通方式调用模型。
        message = await harness.provider.chat(messages, harness.tools.list());
      }
      // 这轮成功拿到模型回复了，说明「提示词过长」的问题（如果之前有过）已经解决，重置重试计数。
      reactiveRetries = 0;
    } catch (error) {
      // 如果是因为「提示词太长」报错，且还没超过重试上限，就主动压缩一次历史再从头重试。
      // 这是一种「被动补救」：平时主动压缩，这里是在真正报错时才紧急压缩。
      if (compactor && isPromptTooLong(error) && reactiveRetries < MAX_REACTIVE_RETRIES) {
        const compacted = await compactor.reactiveCompact(messages, activeRequest);
        messages.splice(0, messages.length, ...compacted);
        restoreSystem(messages, systemMessage);
        reactiveRetries += 1;
        continue; // 直接回到循环开头，用压缩后的历史重新调用模型。
      }
      // 不是「提示词过长」的错误，或者重试次数用完了，就把错误抛出去交给上层处理。
      throw error;
    }
    // 把模型这轮的回复追加到对话里，并同步保存到会话存储（方便后续恢复/追溯）。
    messages.push(message);
    harness.sessionStore?.append(message);
    // 取出模型这轮想要调用的工具列表（可能为空）。
    const toolCalls: ToolCall[] = message.tool_calls ?? [];
    // 如果模型没有要求调用任何工具，说明它觉得自己「说完了」，此时进入「目标检查」环节。
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

    // 两个标记变量，用于「本批次所有工具都执行完之后」的收尾处理：
    // compactRequested：模型是否在本批次里调用了 compact（要求压缩历史）。
    // usedTodo：模型是否在本批次里调用过 todo_write（更新待办清单）。
    let compactRequested = false;
    let usedTodo = false;
    // 逐个执行模型要调用的每个工具。
    for (const call of toolCalls) {
      const name = call.function.name;
      log.debug("tool call", { tool: name });
      // 把模型传过来的 JSON 字符串参数解析成对象（比如 '{"command":"ls"}' -> {command:"ls"}）。
      const input = parseToolArguments(call.function.arguments);
      // 广播「开始调用工具」的事件。
      await events?.emit({ type: "tool_call", id: call.id, name, arguments: call.function.arguments });
      let result: string;
      if (compactor && name === "compact") {
        // compact 是特殊工具：它不真正执行任何动作，只是告诉循环「这轮工具跑完后要压缩历史」。
        // 所以这里不调用 dispatch，也不触发钩子，只是打一个标记，等批次结束后统一处理。
        result = "Compaction requested after this tool batch.";
        compactRequested = true;
      } else if (
        harness.jobs !== undefined &&
        name === "bash" &&
        input["run_in_background"] === true
      ) {
        // 特殊情况：模型想用「后台方式」跑 bash 命令（不阻塞当前对话，命令在后台慢慢跑）。
        const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
        if (blocked !== null) {
          // 如果有钩子拦下这次调用，就直接把拦截的提示当作工具结果。
          result = blocked;
        } else {
          try {
            // 把命令交给后台任务管理器启动，立刻返回（不等待命令跑完）。
            result = harness.jobs.startBackground(String(input["command"] ?? ""));
          } catch (error) {
            // 后台启动失败时，把错误信息包装成结果，让模型能感知到。
            result = `error: ${error instanceof Error ? error.message : String(error)}`;
          }
          // 后台启动成功后，触发「工具调用后」钩子。
          await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
        }
      } else {
        // 普通情况：正常执行一个工具。
        // 先让「工具调用前」钩子有机会拦截；没被拦截就真正调用 dispatch 去执行。
        const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
        if (blocked !== null) {
          result = blocked;
        } else {
          result = await harness.tools.dispatch(name, input);
          await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
        }
        // 如果这次调用的正好是 todo_write，记下标记，稍后提醒模型更新待办进度。
        if (name === "todo_write") usedTodo = true;
      }
      // 广播「工具执行完毕」的事件，同时根据结果开头判断这次是不是出错了（error: 或 denied 开头算错误）。
      await events?.emit({
        type: "tool_result",
        id: call.id,
        name,
        output: result,
        isError: result.startsWith("error:") || result.startsWith("denied"),
      });
      // 把工具结果包装成一条 tool 消息，追加进对话，让模型下一轮能看到执行结果。
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      harness.sessionStore?.append(toolMessage);
    }

    // 如果配置了待办管理器，并且本轮调用过 todo_write，就把「待办进度提醒」拼到最后一条工具结果上。
    const todoManager = harness.todoManager;
    if (todoManager) {
      const reminder = todoManager.noteRound(usedTodo);
      const last = messages[messages.length - 1];
      if (reminder && last?.role === "tool") {
        last.content = (last.content ?? "") + reminder;
      }
    }

    // 如果本批次模型要求过 compact，就在所有工具执行完后真正压缩一次历史，然后进入下一轮。
    if (compactRequested && compactor) {
      const compacted = await compactor.compactHistory(messages, activeRequest);
      messages.splice(0, messages.length, ...compacted);
      restoreSystem(messages, systemMessage);
    }
  }
}

/** 压缩/摘要会把 messages 换成不含 system 的新数组，此处按需把初始 system 挂回队首 */
function restoreSystem(messages: ChatMessage[], systemMessage: ChatMessage): void {
  if (messages[0]?.role !== "system") messages.unshift(systemMessage);
}

/** 一轮对话收尾时评估目标是否已达成；没有目标控制器则直接返回 null */
async function evaluateGoalStop(harness: Harness, messages: ChatMessage[]): Promise<StopDecision | null> {
  const goal = harness.goal;
  if (goal === undefined) return null;
  const backgroundRunning = harness.jobs !== undefined && harness.jobs.background.hasRunning();
  return goal.evaluateAfterTurn(messages, backgroundRunning);
}

/** 目标尚未达成、需要让模型继续干活时，拼出给模型的提示文本 */
function goalReminder(goal: GoalController | undefined, decision: StopDecision): string {
  const condition = goal?.active?.condition ?? "";
  return (
    `[Goal still active]\nCondition: ${condition}\n` +
    `Evaluator: ${decision.reason}\n` +
    "Continue working and surface the missing evidence."
  );
}

/** 消费 Provider 底层流，转发文本增量，返回拼好的最终消息。 */
async function streamAssistantMessage(
  provider: ChatProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  events: EventBus,
): Promise<ChatMessage> {
  const stream = provider.stream!(messages, tools);
  for await (const event of stream) {
    if (event.type === "text_delta") {
      await events.emit({ type: "assistant_text_delta", text: event.text });
    } else if (event.type === "done") {
      return event.message;
    }
  }
  throw new Error("provider stream ended without a done event");
}
