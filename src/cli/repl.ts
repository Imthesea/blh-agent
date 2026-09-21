import readline from "node:readline";
import type { ChatMessage } from "../core/types.js";
import type { TeamAgents } from "../core/harness.js";
import type { JobsRuntime } from "../jobs/runtime.js";
import type { GoalController } from "../goals/controller.js";
import { EventBus, type AgentEvent } from "../core/events.js";
import { setTerminalWriter } from "@blh/logger";

/** /goal 命令的解析结果："status" 查看 / "clear" 清除 / "set" 设置 / null 不是 goal 命令。 */
export type GoalCommand = "status" | "clear" | "set" | null;

/** repl 依赖的最小会话能力：结构化类型，测试可注入 fake。 */
export interface TurnRunner {
  /** 新建一个只含 system 消息的会话。 */
  newSession(): ChatMessage[];
  /** 跑一轮用户对话。 */
  runTurn(messages: ChatMessage[], text: string, events?: EventBus): Promise<void>;
  /** 可选：跑一轮定时任务。 */
  runScheduledTurn?(messages: ChatMessage[]): Promise<void>;
  /** 可选：跑一轮团队任务。 */
  runTeamTurn?(messages: ChatMessage[]): Promise<void>;
  /** 可选：后台任务运行时。 */
  jobs?: JobsRuntime | undefined;
  /** 可选：团队运行时。 */
  agents?: TeamAgents | undefined;
  /** 可选：目标控制器。 */
  goal?: GoalController | undefined;
  /** 可选：把输入解析成 /goal 命令。 */
  goalCommand?: (text: string) => GoalCommand;
}

/** 命令行输入输出接口（repl 用它和终端交互，不直接碰 readline）。 */
export interface ReplIO {
  /** 读一行输入；返回 null 表示输入流结束（EOF）。 */
  readLine: () => Promise<string | null>;
  /** 打印一行文本（自带换行）。 */
  print: (text: string) => void;
  /** 写文本但不换行（用于流式输出模型回复的片段）。 */
  write: (text: string) => void;
}

/** 从 start 起向队尾找最后一条 assistant 文本，只取本轮新增，避免打印 scheduled 旧回复。 */
function lastAssistantTextFrom(messages: ChatMessage[], start: number): string {
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content) return message.content;
  }
  return "";
}

/** 把一条高层事件渲染到终端：文本增量原样写，工具/轮次边界换行。 */
function renderStreamEvent(io: ReplIO, event: AgentEvent, state: { textOpen: boolean }): void {
  // state.textOpen 记录「当前是否正处于一段连续文本输出的中间」。
  // 当后面要输出工具/结束信息时，如果文本还没换行，得先补一个换行，否则会和文本黏在一起。
  switch (event.type) {
    case "turn_start":
      // 一轮开始，无需渲染任何东西。
      return;
    case "assistant_text_delta":
      // 模型流式输出的一段文字：直接原样写，不换行，并标记「正在输出文本」。
      state.textOpen = true;
      io.write(event.text);
      return;
    case "tool_call":
      // 模型要调用工具：先给上面的文本收尾换行，再打印 [tool] 工具名 + 参数。
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      io.print(`[tool] ${event.name} ${event.arguments}`);
      return;
    case "tool_result":
      // 工具执行结果：同样先换行，再打印 [ok]/[error] + 工具名。
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      io.print(`${event.isError ? "[error]" : "[ok]"} ${event.name}`);
      return;
    case "turn_end":
      // 一轮结束：如果还有未闭合的文本，补一个换行收尾。
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      return;
  }
}

/** 造一个命令行输入输出对象：readLine 负责读一行，print 负责打印；打印时会处理"正在等输入"时的清屏重绘。 */
export function makeReadlineIO(rl?: readline.Interface): ReplIO {
  // 没传就自己建一个，默认读 stdin、写 stdout。
  const readlineInterface =
    rl ??
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  // 标记当前是否正挂着 readline.question 等用户输入（即屏幕上显示着 "> " 提示符）。
  let awaitingInput = false;
  // 让日志系统的终端输出也接入「等待输入时清行重绘」，避免后台日志（如 MCP 连接完成）覆盖 "> " 提示符。
  // 非等待输入时仍写 stderr，保持日志原有语义。
  setTerminalWriter((text) => {
    if (awaitingInput) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(text);
      readlineInterface.prompt(true);
    } else {
      process.stderr.write(text);
    }
  });
  return {
    readLine: () =>
      new Promise((resolve) => {
        // 输入流被关闭（比如 Ctrl+D）时，把 awaitingInput 复位并返回 null（EOF）。
        const onClose = () => {
          awaitingInput = false;
          resolve(null);
        };
        readlineInterface.once("close", onClose);
        // 挂起提示符，等用户输入一行。
        awaitingInput = true;
        readlineInterface.question("> ", (answer) => {
          awaitingInput = false;
          readlineInterface.removeListener("close", onClose);
          resolve(answer);
        });
      }),
    print: (text) => {
      if (awaitingInput) {
        // 提示符还挂在屏幕上：先清掉当前行、光标回到行首，输出内容后再重画提示符，
        // 避免输出和 "> " 黏在一起（这正是修复「后台输出覆盖提示符导致假死」的关键逻辑）。
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`${text}\n`);
        readlineInterface.prompt(true);
      } else {
        console.log(text);
      }
    },
    write: (text) => {
      if (awaitingInput) {
        // 同上，只是 write 不额外换行（流式输出片段用）。
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(text);
        readlineInterface.prompt(true);
      } else {
        process.stdout.write(text);
      }
    },
  };
}

/** 交互式主循环：读用户输入 → 跑一轮智能体 → 打印回复；同时接上定时任务和团队任务的后台处理。 */
export async function repl(
  agent: TurnRunner,
  io: ReplIO,
  initialMessages?: ChatMessage[],
): Promise<void> {
  // 打印欢迎语。
  io.print("blh — type 'exit' to quit");
  // 用传入的会话继续，没传就新建一个。
  const messages = initialMessages ?? agent.newSession();
  // 取出各可选依赖（这些在非完整 harness 的场景下可能是 undefined）。
  const jobs = agent.jobs;
  const runScheduledTurn = agent.runScheduledTurn?.bind(agent);
  const agents = agent.agents;
  const runTeamTurn = agent.runTeamTurn?.bind(agent);
  const goal = agent.goal;
  const goalCommand = agent.goalCommand?.bind(agent);
  try {
    // 接上定时任务：注册一个回调，定时器触发时跑一轮定时任务，再把本轮新增的回复打印出来。
    if (jobs !== undefined && runScheduledTurn !== undefined) {
      jobs.setCronTurn(async () => {
        const before = messages.length;
        await runScheduledTurn(messages);
        const reply = lastAssistantTextFrom(messages, before);
        if (reply) io.print(reply);
      });
      // 启动定时调度。
      jobs.start();
    }
    // 接上团队任务：注册一个回调，队友消息到达时跑一轮团队任务，同样打印新增回复。
    if (agents !== undefined && runTeamTurn !== undefined) {
      agents.setTeamTurn?.(async () => {
        const before = messages.length;
        await runTeamTurn(messages);
        const reply = lastAssistantTextFrom(messages, before);
        if (reply) io.print(reply);
      });
      agents.start?.();
    }
    // 主循环：不断读用户输入并处理，直到退出。
    for (;;) {
      // 读一行输入；null 表示 EOF（Ctrl+D 或输入流关闭），打印空行后退出。
      const line = await io.readLine();
      if (line === null) {
        io.print("");
        break;
      }
      let text = line.trim();
      // 输入 exit / quit 就退出。
      if (text === "exit" || text === "quit") break;
      // 空行直接跳过，等下一行。
      if (!text) continue;
      // 处理 /goal 命令（查看/清除/设置目标）。
      if (goal !== undefined && goalCommand !== undefined) {
        const cmd = goalCommand(text);
        if (cmd === "status") {
          // 查看目标状态，打印后回到循环。
          io.print(goal.status(0));
          continue;
        }
        if (cmd === "clear") {
          // 清除目标，打印结果后回到循环。
          io.print(goal.clear());
          continue;
        }
        if (cmd === "set") {
          // 设置目标：把 "/goal xxx" 去掉 "/goal " 前缀（6 个字符）作为目标内容，
          // 同时让这一轮输入也变成目标描述，交给下面的 agent 处理。
          goal.setGoal(text.slice(6).trim());
          text = text.slice(6).trim();
        }
      }
      try {
        // 一轮对话的执行体：跑 agent，并把流式事件渲染到终端。
        const run = async () => {
          // 记录本轮开始前的消息数，用于最后只取「本轮新增」的回复。
          const turnStart = messages.length;
          // 每轮新建一个事件总线，收集本轮产生的流式事件。
          const events = new EventBus();
          // 是否正在输出一段连续文本（跨事件复用）。
          const state = { textOpen: false };
          // 是否已经流式输出过文本（若走的是流式，就不要再重复打印最终文本）。
          let streamed = false;
          const off = events.subscribe((event) => {
            if (event.type === "assistant_text_delta") streamed = true;
            renderStreamEvent(io, event, state);
          });
          try {
            await agent.runTurn(messages, text, events);
          } finally {
            // 无论成功失败，都取消订阅，避免泄漏。
            off();
          }
          // 如果没有走流式输出（比如没收到任何文本增量事件），就直接打印最后一条回复兜底。
          if (!streamed) io.print(lastAssistantTextFrom(messages, turnStart));
        };
        // 有后台任务运行时，用锁串行执行本轮，避免和定时/团队任务并发冲突。
        if (jobs !== undefined) {
          await jobs.agentLock.withLock(run);
        } else {
          await run();
        }
      } catch (error) {
        // 单轮出错只打印错误、继续循环，不让整个 repl 崩溃退出。
        io.print(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    // 退出前清理：停掉团队运行时和后台任务。
    agents?.stop?.();
    if (jobs !== undefined) jobs.stop();
  }
}
