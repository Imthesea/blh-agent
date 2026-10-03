import { POST_TOOL_USE, PRE_TOOL_USE } from "../core/hooks.js";
import type { HookBus } from "../core/hooks.js";
import { parseToolArguments } from "../core/parse-args.js";
import type { ChatMessage, ChatProvider, Config, ToolCall } from "../core/types.js";
import { runInScheduledTurn } from "../security/approval.js";
import { runBash } from "../tools/bash.js";
import { editFile, readFile, writeFile } from "../tools/files.js";
import { glob } from "../tools/glob.js";
import { ToolRegistry } from "../tools/registry.js";
import type { BusMessage } from "./bus.js";
import type { Task, TaskStore } from "../planning/tasks.js";

const IDLE_SCAN_INTERVAL = 2000;

/** TeammateRuntime 依赖的 TeamRuntime 能力（结构化类型，避免与 team.ts 的循环 import）。 */
export interface TeammateTeam {
  assignmentCwd(owner: string): string;
  claimTask(owner: string, taskId: string): string;
  completeTask(owner: string, taskId: string): string;
  listTasks(): Task[];
  sendMessage(
    fromName: string,
    to: string,
    content: string,
    msgType?: string,
    metadata?: Record<string, unknown>,
  ): string;
  submitPlan(fromName: string, plan: string): string;
  applyShutdownRequest(name: string, msg: BusMessage): [boolean, string];
  applyPlanResponse(name: string, msg: BusMessage): [boolean, string];
  getPlanGate(name: string): string;
  setActive(name: string, status: string): void;
  releaseCompleted(name: string): void;
  finishTeammate(name: string): void;
  claimNextTask(name: string): Task | null;
  readInbox(name: string): BusMessage[];
  waitForMessages(name: string, timeoutMs?: number): Promise<BusMessage[]>;
}

const ICONS: Record<string, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

export class TeammateRuntime {
  readonly tools: ToolRegistry;
  readonly messages: ChatMessage[];
  private readonly system: string;

  /**
   * 构造函数：创建一个"队友"的运行器。
   *
   * 一个队友就是一个独立的 AI 助手，负责完成分配给它的某个具体任务。
   * 这里做了三件事：
   * 1. 记下队友的基本信息（名字 name、角色 role、任务 id、要不要先交计划）。
   * 2. 拼出一段"系统提示词"（告诉这个 AI 它是什么身份、要遵守什么规则），
   *    再拼出第一条"用户消息"（把具体任务内容告诉它）。
   * 3. 准备好它能用的一堆工具（bash、读写文件等）。
   */
  constructor(
    readonly name: string,
    readonly role: string,
    prompt: string,
    readonly taskId: string | null,
    readonly requirePlan: boolean,
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
    readonly store: TaskStore,
    readonly team: TeammateTeam,
  ) {
    this.system =
      `你是 '${name}'，一名 ${role}。用工具完成分配给你的任务，` +
      "完成后调用 complete_task 并报告一个简洁的结果。 " +
      "如果第一条用户消息里包含 [Assigned task]，说明这个任务已经被认领了，不要再调用 claim_task。 " +
      "当被要求提交计划时，调用 submit_plan，并在用 bash 或改文件之前等待审批。 " +
      "文件工具和 shell 工具都在任务的工作目录里执行，那个目录不是沙箱。 " +
      "运行时会把你最终的文本交给 Lead。send_message 只用于中间协调，并称呼协调者为 'lead'。";

    let userContent = prompt;
    if (taskId) {
      const task = store.load(taskId);
      const cwd = team.assignmentCwd(name);
      userContent += `\n\n[Assigned task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`;
    }
    if (requirePlan) {
      userContent +=
        "\n\n[Plan required] Submit a plan and wait for Lead approval before changing files or using bash.";
    }
    this.messages = [
      { role: "system", content: this.system },
      { role: "user", content: userContent },
    ];
    this.tools = this.buildTools();
  }

  /**
   * 给这个队友注册它能用的工具。
   *
   * "工具"就是 AI 可以调用的函数，比如执行命令、读写文件、发消息、认领任务等。
   * 每个工具都要说明：叫什么名字、干什么用、需要哪些参数（参数长什么样）。
   * 这样模型才知道在什么情况下该调用哪个工具、该传什么参数。
   */
  private buildTools(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "Run a shell command in the task's working directory.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      handler: async (args) => this.runBash(args),
    });
    registry.register({
      name: "read_file",
      description: "Read a file with line numbers in the task's working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
      handler: async (args) => this.runRead(args),
    });
    registry.register({
      name: "write_file",
      description: "Write content to a file in the task's working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: async (args) => this.runWrite(args),
    });
    registry.register({
      name: "edit_file",
      description: "Replace old_text with new_text in the task's working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
      handler: async (args) => this.runEdit(args),
    });
    registry.register({
      name: "glob",
      description: "Find files matching a glob pattern in the task's working directory.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      handler: async (args) => this.runGlob(args),
    });
    registry.register({
      name: "send_message",
      description: "Send an intermediate message to 'lead' or an active teammate.",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, content: { type: "string" } },
        required: ["to", "content"],
      },
      handler: async (args) =>
        this.team.sendMessage(this.name, String(args["to"] ?? ""), String(args["content"] ?? "")),
    });
    registry.register({
      name: "submit_plan",
      description: "Submit a work plan for Lead approval.",
      parameters: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
      handler: async (args) => this.team.submitPlan(this.name, String(args["plan"] ?? "")),
    });
    registry.register({
      name: "list_tasks",
      description: "List shared tasks.",
      parameters: { type: "object", properties: {} },
      handler: async () => this.renderTasks(),
    });
    registry.register({
      name: "claim_task",
      description: "Claim a ready task.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
      handler: async (args) => this.team.claimTask(this.name, String(args["task_id"] ?? "")),
    });
    registry.register({
      name: "complete_task",
      description: "Complete an owned task.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
      handler: async (args) => this.team.completeTask(this.name, String(args["task_id"] ?? "")),
    });
    return registry;
  }

  /**
   * 拿到这个队友当前任务的工作目录（也就是它该在哪个文件夹里干活）。
   *
   * 成功时返回 { cwd: "路径" }；失败时返回 { error: "原因" }。
   * 之所以用对象包一层，是因为调用方只要判断有没有 "error" 字段，
   * 就能知道到底是成功了还是失败了。
   */
  private currentCwd(): { cwd: string } | { error: string } {
    try {
      return { cwd: this.team.assignmentCwd(this.name) };
    } catch (error) {
      return {
        error: `Error: Invalid task assignment: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 执行一条 shell 命令（"bash" 工具的真正实现）。
   *
   * 先拿到工作目录，拿不到就直接返回错误信息，不去执行命令；
   * 拿得到就把命令交给 runBash 函数去执行，并带上超时时间、输出长度上限这些配置。
   */
  private async runBash(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return runBash(current.cwd, this.config.bashTimeout, this.config.maxOutputChars, args);
  }

  /**
   * 读取一个文件的内容（"read_file" 工具的真正实现）。
   *
   * 先拿到工作目录，拿不到就返回错误；拿得到就在这个目录里读文件。
   */
  private async runRead(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return readFile(current.cwd, args);
  }

  /**
   * 把一个字符串内容写进文件（"write_file" 工具的真正实现）。
   *
   * 先拿到工作目录，拿不到就返回错误；拿得到就在这个目录里写文件。
   */
  private async runWrite(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return writeFile(current.cwd, args);
  }

  /**
   * 修改一个文件的某一段内容（"edit_file" 工具的真正实现）。
   *
   * 做法是：把文件里的一小段旧文字（old_text）替换成新文字（new_text）。
   * 先拿到工作目录，拿不到就返回错误；拿得到就在这个目录里改文件。
   */
  private async runEdit(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return editFile(current.cwd, args);
  }

  /**
   * 按通配符模式找文件（"glob" 工具的真正实现）。
   *
   * 比如用 "src/*.ts" 就能找到 src 目录下所有 .ts 文件。
   * 先拿到工作目录，拿不到就返回错误；拿得到就在这个目录里找。
   */
  private async runGlob(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return glob(current.cwd, args);
  }

  /**
   * 把共享任务列表整理成一段给人看的文本，方便队友了解整体进度。
   *
   * 每个任务占一行，内容包括：
   * - 状态图标（[ ] 未开始、[~] 进行中、[x] 已完成）
   * - 任务 id 和标题
   * - 当前状态、是谁在负责
   * - 它被哪些任务挡着（blocked_by，依赖没做完它就不能开始）
   * - 关联的工作树（worktree，也就是在哪个目录里干这个活）
   */
  private renderTasks(): string {
    const tasks = this.team.listTasks();
    if (tasks.length === 0) return "No tasks.";
    return tasks
      .map((task) => {
        const deps = task.blocked_by.length > 0 ? ` (blocked_by: ${task.blocked_by.join(", ")})` : "";
        const owner = task.owner ? ` [${task.owner}]` : "";
        const wt = task.worktree ? ` (worktree: ${task.worktree})` : "";
        return `${ICONS[task.status] ?? "[?]"} ${task.id}: ${task.subject} [${task.status}]${owner}${deps}${wt}`;
      })
      .join("\n");
  }

  /**
   * 执行一个工具调用（这是所有工具的统一入口）。
   *
   * 执行前会做两重把关：
   * 1. 计划审批：如果是 bash、写文件、改文件这类"会改动东西"的工具，
   *    而且这个队友还没通过计划审批，就直接拦下，返回"Blocked"。
   * 2. 权限钩子：执行前、执行后各触发一次钩子，让外部代码有机会拦截或记录。
   *
   * 都通过之后，才真正执行工具并返回结果。
   */
  private async runTool(event: { name: string; input: Record<string, unknown> }): Promise<string> {
    const name = event.name;
    const gate = this.team.getPlanGate(this.name);
    if (
      (name === "bash" || name === "write_file" || name === "edit_file") &&
      gate !== "not_required" &&
      gate !== "approved"
    ) {
      return `Blocked: plan status is ${gate}.`;
    }
    return runInScheduledTurn(async () => {
      const blocked = await this.hooks.firstBlock(PRE_TOOL_USE, { name, input: event.input });
      if (blocked !== null) return blocked;
      const result = await this.tools.dispatch(name, event.input);
      await this.hooks.trigger(POST_TOOL_USE, { name, input: event.input, output: result });
      return result;
    });
  }

  /**
   * 处理这个队友收件箱里的一堆消息，返回它是否需要立刻停下来。
   *
   * 收件箱里可能有几种消息，各处理各的：
   * - 关闭请求（shutdown_request）：lead 让它收工。如果请求合法，就回复"收到"并返回 true，
   *   表示这个队友要停下来了。
   * - 计划审批结果（plan_approval_response）：lead 批准或拒绝了它的计划，把它转成一句提示。
   * - 计划要求（plan_request）：lead 要求它先交计划，转成一句提示。
   * - 普通消息：转成"[Message from 谁] 内容"这样的提示。
   *
   * 最后把上面这些提示拼成一条用户消息，追加进对话历史，让 AI 下一轮能看到。
   */
  handleInbox(inbox: BusMessage[]): boolean {
    const workMessages: string[] = [];
    for (const msg of inbox) {
      if (msg.type === "shutdown_request") {
        const [accepted, notice] = this.team.applyShutdownRequest(this.name, msg);
        if (!accepted) {
          workMessages.push(notice);
          continue;
        }
        this.team.sendMessage(this.name, "lead", "Shutdown acknowledged.", "shutdown_response", {
          request_id: notice,
          approve: true,
        });
        return true;
      }
      if (msg.type === "plan_approval_response") {
        const [, notice] = this.team.applyPlanResponse(this.name, msg);
        workMessages.push(notice);
        continue;
      }
      if (msg.type === "plan_request") {
        workMessages.push(`[Plan required] ${msg.content}`);
        continue;
      }
      workMessages.push(`[Message from ${msg.from}] ${msg.content}`);
    }
    if (workMessages.length > 0) {
      this.messages.push({ role: "user", content: workMessages.join("\n") });
    }
    return false;
  }

  /**
   * 队友空闲时在这里循环"等活干"，返回是不是有新活需要处理。
   *
   * 循环一直转，每次做两件事：
   * 1. 看看收件箱有没有新消息。有就处理；如果处理时发现是"关闭请求"，就返回 false
   *    （表示不用再干活了）。如果处理完确实多了新消息，返回 true（有新活）。
   * 2. 如果没消息，就试着去认领下一个能做的任务。认领到了就把任务内容追加进对话，
   *    并返回 true；没任务就继续下一轮循环。
   *
   * 每轮循环之间会等待一小段时间（IDLE_SCAN_INTERVAL），避免空转太频繁。
   */
  async waitForWork(): Promise<boolean> {
    for (;;) {
      const inbox = await this.team.waitForMessages(this.name, IDLE_SCAN_INTERVAL);
      if (inbox.length > 0) {
        const before = this.messages.length;
        if (this.handleInbox(inbox)) return false;
        if (this.messages.length > before) return true;
        continue;
      }
      const task = this.team.claimNextTask(this.name);
      if (!task) continue;
      const cwd = this.team.assignmentCwd(this.name);
      this.messages.push({
        role: "user",
        content: `[Auto-claimed task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`,
      });
      return true;
    }
  }

  /**
   * 让队友"干一轮活"，返回它下一步该处于什么状态。
   *
   * 一轮的完整流程：
   * 1. 处理收件箱，如果需要停就返回 "stop"。
   * 2. 把自己标成"工作中"。
   * 3. 调用模型（AI），把当前对话历史和可用工具清单交给它，让它决定下一步。
   *    如果调用出错，就发条错误消息给 lead，然后返回 "stop"。
   * 4. 模型如果要调用工具，就逐个执行，把结果回填进对话，返回 "continue"（接着再来一轮）。
   * 5. 模型如果不调用工具，说明它这一轮给出了文本答复：
   *    - 如果计划还没通过，就把审批要求写回对话并返回 "continue"，让模型重新提交计划。
   *    - 如果计划在等审批，就把自己标成"等待审批"。
   *    - 否则汇报结果给 lead，释放任务，标成"空闲"，返回 "idle"。
   */
  async work(): Promise<string> {
    if (this.handleInbox(this.team.readInbox(this.name))) return "stop";
    this.team.setActive(this.name, "working");
    let assistant: ChatMessage;
    try {
      assistant = await this.provider.chat(this.messages, this.tools.list());
    } catch (error) {
      this.team.sendMessage(
        this.name,
        "lead",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        "error",
      );
      return "stop";
    }
    this.messages.push(assistant);
    const toolCalls: ToolCall[] = assistant.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const name = call.function.name;
        const input = parseToolArguments(call.function.arguments);
        const result = await this.runTool({ name, input });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      return "continue";
    }
    const summary = assistant.content ?? "";
    const gate = this.team.getPlanGate(this.name);
    if ((gate === "not_required" || gate === "approved") && summary) {
      this.team.sendMessage(this.name, "lead", summary, "result");
    }
    if (gate === "pending") {
      this.team.setActive(this.name, "waiting_approval");
      return "idle";
    }
    if (gate === "required" || gate === "rejected") {
      const notice =
        gate === "rejected"
          ? "[Plan rejected] Revise the plan and call submit_plan again."
          : "[Plan required] Call submit_plan and wait for approval before changing files or using bash.";
      this.messages.push({ role: "user", content: notice });
      return "continue";
    } else {
      this.team.releaseCompleted(this.name);
      this.team.setActive(this.name, "idle");
      this.team.sendMessage(this.name, "lead", "Waiting for more work.", "idle_notification");
    }
    return "idle";
  }

  /**
   * 队友的主循环：一直干活，直到被要求关闭或出错为止。
   *
   * 循环逻辑：
   * - 状态是 "idle"（空闲）时，先去等活（waitForWork）；等不到就退出循环。
   * - 然后干一轮活（work），根据返回的状态决定是继续、还是停下。
   *
   * 不管最后是怎么结束的，都会走 finally 里的收尾清理（finishTeammate），
   * 保证这个队友留下的状态被清干净。
   */
  async run(): Promise<void> {
    try {
      let state = "continue";
      while (state !== "stop") {
        if (state === "idle" && !(await this.waitForWork())) break;
        state = await this.work();
      }
    } catch (error) {
      try {
        this.team.sendMessage(
          this.name,
          "lead",
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          "error",
        );
      } catch {
        // 收尾阶段的发送失败可忽略
      }
    } finally {
      try {
        this.team.finishTeammate(this.name);
      } catch {
        // 收尾阶段的清理失败可忽略
      }
    }
  }
}
