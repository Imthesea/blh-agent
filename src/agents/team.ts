import * as path from "node:path";
import { createLogger } from "@blh/logger";
import type { ChatMessage, ChatProvider, Config } from "../core/types.js";
import type { HookBus } from "../core/hooks.js";
import type { AgentLock } from "../jobs/runtime.js";
import type { Task, TaskStore } from "../planning/tasks.js";
import { isValidAgentName, MessageBus } from "./bus.js";
import type { BusMessage } from "./bus.js";
import { TeammateRuntime } from "./teammate.js";
import type { TeammateTeam } from "./teammate.js";
import { createWorktree as createWorktreeOp, taskCwd as taskCwdOp } from "./worktree.js";

const RESERVED_TEAMMATE_NAMES = new Set(["lead", "agent"]);

const log = createLogger("agents.team");

interface ProtocolState {
  requestId: string;
  type: string;
  sender: string;
  target: string;
  status: string;
  payload: string;
  workVersion: number | null;
  taskId: string | null;
  createdAt: number;
}

interface Assignment {
  taskId: string;
  cwd: string;
}

/** TeamRuntime：组合 MessageBus / TeammateRuntime / 协议 / assignment / plan gate。 */
export class TeamRuntime implements TeammateTeam {
  readonly activeTeammates = new Map<string, string>();
  readonly planGates = new Map<string, string>();
  readonly planRequestIds = new Map<string, string>();
  readonly pendingRequests = new Map<string, ProtocolState>();
  readonly assignments = new Map<string, Assignment>();
  readonly assignmentVersions = new Map<string, number>();
  started = false;

  private teamTurn: (() => Promise<void>) | null = null;
  private leadTimer: NodeJS.Timeout | undefined;

  /**
   * 构造函数：把团队运行时要用的所有"零件"存起来备用。
   *
   * 这些零件包括：
   * - store：任务仓库，负责增删查改任务。
   * - bus：消息总线，队友之间靠它互相收发消息。
   * - agentLock：一把锁，保证同一时刻只有一个 agent 在干活，避免互相打架。
   * - workdir / worktreesDir：主工作目录、以及存放各个"工作树"的目录。
   * - provider：模型（AI）的调用入口。
   * - config：各种配置项。
   * - hooks：钩子，用于在工具执行前后插入自定义逻辑。
   */
  constructor(
    readonly store: TaskStore,
    readonly bus: MessageBus,
    readonly agentLock: AgentLock,
    readonly workdir: string,
    readonly worktreesDir: string,
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
  ) {}

  // ---- 生命周期 ----
  /**
   * 登记一个"lead 轮次"回调函数。
   *
   * lead 是整个团队的领队（主智能体）。这个回调就是"lead 该出来处理事情"时要执行的动作。
   * 团队启动后，后台定时器发现 lead 收件箱有消息，就会调用这个回调，
   * 让 lead 出来处理队友发来的消息。
   */
  setTeamTurn(callback: () => Promise<void>): void {
    this.teamTurn = callback;
  }

  /**
   * 启动团队。
   *
   * 启动后，后台会每隔 200 毫秒检查一次 lead 的收件箱，
   * 如果发现有新消息，就触发一次 lead 轮次去处理。
   * 如果团队已经启动过了，就直接返回，不做重复启动。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.leadTimer = setInterval(() => {
      void this.leadTick();
    }, 200);
    this.leadTimer.unref();
  }

  /**
   * 停止团队。
   *
   * 先停掉后台的定时器（不再检查收件箱），
   * 然后给每一个还在干活的队友发一条"关闭请求"，让它们各自收工。
   * 如果团队本来就没启动，就直接返回。
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.leadTimer !== undefined) clearInterval(this.leadTimer);
    this.leadTimer = undefined;
    for (const name of [...this.activeTeammates.keys()]) {
      this.requestShutdown(name);
    }
  }

  /**
   * 后台定时器执行的动作。
   *
   * 做两重判断：
   * 1. lead 收件箱里有没有消息？没有就什么都不做，直接返回。
   * 2. 能不能拿到那把全局锁？拿不到（说明别人在干活）就返回，避免并发冲突。
   *
   * 两个条件都满足，才真正执行一次"team 轮次"（也就是调用前面登记的 teamTurn 回调）。
   * 无论执行成功还是失败，最后都会释放锁。
   */
  private async leadTick(): Promise<void> {
    if (!this.bus.peek("lead")) return;
    if (!this.agentLock.tryAcquire()) return;
    try {
      if (this.teamTurn !== null) await this.teamTurn();
    } catch (error) {
      log.warn("lead tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.agentLock.release();
    }
  }

  // ---- bus 委托（teammate 侧） ----
  /**
   * 读取某个 agent 的收件箱（里面是别人发给它的、还没处理的消息）。
   *
   * 这个方法是给"队友"那边用的，直接转给消息总线去读。
   */
  readInbox(name: string): BusMessage[] {
    return this.bus.readInbox(name);
  }

  /**
   * 等某个 agent 的新消息（可以设置最多等多久）。
   *
   * 同样直接转给消息总线。队友空闲时靠它来"守株待兔"等新消息。
   */
  waitForMessages(name: string, timeoutMs?: number): Promise<BusMessage[]> {
    return this.bus.waitForMessages(name, timeoutMs);
  }

  // ---- assignment / 任务 ----
  /**
   * 返回某个队友当前任务的工作目录（它该在哪个文件夹里干活）。
   *
   * 这个方法会先做一次"对账"，确保信息是最新且一致的：
   * 1. 如果队友有正在进行中的任务，但记录里的任务 id 对不上，就重新算出工作目录并记录。
   * 2. 如果队友根本没任务，就报错：先去认领任务才能用工作目录相关的工具。
   * 3. 最后再校验一遍：任务状态还对吗？还属于这个队友吗？目录路径变了吗？
   *    任何一项对不上都会报错。
   *
   * 都通过后，才把工作目录返回出去。
   */
  assignmentCwd(owner: string): string {
    let assignment = this.assignments.get(owner);
    const inProgress = this.ownerInProgress(owner);
    if (inProgress && (!assignment || assignment.taskId !== inProgress.id)) {
      const cwd = this.taskCwd(inProgress);
      assignment = { taskId: inProgress.id, cwd };
      this.assignments.set(owner, assignment);
    } else if (!assignment) {
      throw new Error("Claim a Task before using workspace tools.");
    }
    const current = assignment;
    const task = this.store.load(current.taskId);
    if ((task.status !== "in_progress" && task.status !== "completed") || task.owner !== owner) {
      throw new Error(`Assignment for ${owner} is no longer active`);
    }
    const cwd = this.taskCwd(task);
    if (path.resolve(cwd) !== path.resolve(current.cwd)) {
      throw new Error(`Assignment cwd changed for task ${task.id}`);
    }
    return cwd;
  }

  /**
   * 找出某个队友"正在进行中"的任务。
   *
   * 遍历所有任务，返回那个"状态是 in_progress、且负责人是这个队友"的任务；
   * 找不到就返回 null（表示它现在手里没活）。
   */
  private ownerInProgress(owner: string): Task | null {
    for (const task of this.store.list()) {
      if (task.status === "in_progress" && task.owner === owner) return task;
    }
    return null;
  }

  /**
   * 算出一个任务对应的工作目录。
   *
   * 具体怎么算交给 worktree 模块的 taskCwdOp 函数，这里只是传参调用。
   */
  private taskCwd(task: Task): string {
    return taskCwdOp(task, this.workdir, this.worktreesDir);
  }

  /**
   * 让某个队友"认领"一个任务（也就是把任务标记成由它来做）。
   *
   * 流程：
   * 1. 先检查这个队友是不是已经有别的任务在做了，有的话直接返回提示，不让它同时干两件事。
   * 2. 调用任务仓库去认领；认领失败（比如任务已经被别人拿走）就把错误信息当结果返回。
   * 3. 认领成功（返回结果以 "Claimed " 开头），就记下它负责的任务和对应工作目录，
   *    并把它的"版本号"加一（表示它手里的活变了，之前交的计划作废）。
   *
   * 返回一段给人看的文字，说明认领结果。
   */
  claimTask(owner: string, taskId: string): string {
    if (this.assignments.has(owner) || this.ownerInProgress(owner) !== null) {
      return "Owner must complete its current task first";
    }
    let result: string;
    try {
      result = this.store.claim(taskId, owner);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (result.startsWith("Claimed ")) {
      const task = this.store.load(taskId);
      const cwd = this.taskCwd(task);
      this.assignments.set(owner, { taskId: task.id, cwd });
      this.bumpVersion(owner);
    }
    return result;
  }

  /**
   * 让某个队友把一个任务标记成"已完成"。
   *
   * 直接调用任务仓库去完成；如果出错（比如这个任务不归它管），
   * 就把错误信息当成文本返回，而不是抛出异常。
   */
  completeTask(owner: string, taskId: string): string {
    try {
      return this.store.complete(taskId, owner);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * 列出当前所有的任务（原样返回任务仓库里的任务列表）。
   */
  listTasks(): Task[] {
    return this.store.list();
  }

  /**
   * 扫描出所有"现在就能认领"的任务。
   *
   * 一个任务要满足下面全部条件才算"能认领"：
   * 1. 状态是 pending（还没开始）。
   * 2. 还没人认领（owner 是 null）。
   * 3. 它依赖的其他任务都已经做完（canStart 返回 true）。
   * 4. 能算出它的工作目录（算不出来就跳过，说明这个任务现在没法干）。
   */
  private scanUnclaimed(): Task[] {
    const ready: Task[] = [];
    for (const task of this.store.list()) {
      if (task.status !== "pending" || task.owner !== null) continue;
      if (!this.store.canStart(task.id)) continue;
      try {
        this.taskCwd(task);
      } catch {
        continue;
      }
      ready.push(task);
    }
    return ready;
  }

  /**
   * 让某个队友自动认领"下一个能做的任务"。
   *
   * 先看这个队友是不是已经有活（有就返回 null，不重复认领）。
   * 然后遍历所有能认领的任务，逐个尝试认领，第一个认领成功的就返回它。
   * 一个都认领不到，返回 null。
   */
  claimNextTask(name: string): Task | null {
    if (this.assignments.has(name) || this.ownerInProgress(name) !== null) return null;
    for (const task of this.scanUnclaimed()) {
      const result = this.claimTask(name, task.id);
      if (result.startsWith("Claimed ")) return this.store.load(task.id);
    }
    return null;
  }

  /**
   * 把某个队友的"版本号"加一，表示它手里的活变了（比如换了新任务）。
   *
   * 版本号的作用是判断"之前交的计划还算不算数"：
   * 一旦换了活，之前交的计划就过期了，所以这里会：
   * - 如果它本来需要交计划，就把它打回"需要重新交计划"的状态。
   * - 清掉它旧的计划请求记录（那条计划作废了）。
   */
  private bumpVersion(owner: string): void {
    this.assignmentVersions.set(owner, (this.assignmentVersions.get(owner) ?? 0) + 1);
    const gate = this.planGates.get(owner);
    if (gate !== undefined && gate !== "not_required") {
      this.planGates.set(owner, "required");
    }
    this.planRequestIds.delete(owner);
  }

  /**
   * 返回某个队友"当前在干哪份活"的标识，也就是 [版本号, 任务 id]。
   *
   * 这两个值一起用来判断：某条计划到底是针对哪份活、现在还有没有效。
   * 如果版本号或任务 id 对不上，就说明那份计划已经过期了。
   */
  private currentWorkIdentity(owner: string): [number, string | null] {
    const assignment = this.assignments.get(owner);
    return [this.assignmentVersions.get(owner) ?? 0, assignment ? assignment.taskId : null];
  }

  /**
   * 队友把手里的任务做完之后，清理它的"任务归属"记录。
   *
   * 具体做三件事：
   * 1. 确认这个任务真的已经完成、而且确实是这个队友做的（不是就不清理）。
   * 2. 删掉"这个队友负责哪个任务"的记录。
   * 3. 版本号加一（活变了），并把它的计划状态设成"不用交计划"（下一份活再说）。
   */
  releaseCompleted(owner: string): void {
    const assignment = this.assignments.get(owner);
    if (!assignment) return;
    const task = this.store.load(assignment.taskId);
    if (task.status !== "completed" || task.owner !== owner) return;
    this.assignments.delete(owner);
    this.bumpVersion(owner);
    this.planGates.set(owner, "not_required");
  }

  /**
   * 给某个队友做"收尾清理"（它要退出时调用）。
   *
   * 做这几件事：
   * 1. 如果它手里还有个进行中的任务，就把那个任务重置回"未开始"（pending）、
   *    清掉负责人，这样别的队友还能接这个活。
   * 2. 删掉它的任务归属、版本号、计划状态、计划请求、活跃状态等所有相关记录。
   */
  finishTeammate(owner: string): void {
    const task = this.ownerInProgress(owner);
    if (task) {
      task.status = "pending";
      task.owner = null;
      this.store.save(task);
    }
    this.assignments.delete(owner);
    this.bumpVersion(owner);
    this.planGates.delete(owner);
    this.planRequestIds.delete(owner);
    this.activeTeammates.delete(owner);
  }

  // ---- 协议（teammate 侧） ----
  /**
   * 队友给 lead（领队）或另一个正在干活的队友发一条消息。
   *
   * 先检查收件人是否合法：要么是 lead，要么是当前活跃的队友；
   * 不合法就返回"该 agent 不活跃"的提示。
   * 合法就把消息投递进消息总线，返回"已发送"。
   */
  sendMessage(
    fromName: string,
    to: string,
    content: string,
    msgType = "message",
    metadata: Record<string, unknown> = {},
  ): string {
    if (to !== "lead" && !this.activeTeammates.has(to)) {
      return `Agent '${to}' is not active`;
    }
    this.bus.send(fromName, to, content, msgType, metadata);
    return `Sent to ${to}`;
  }

  /**
   * 队友提交一份工作计划，等 lead 审批。
   *
   * 流程：
   * 1. 记下它当前的任务 id 和版本号（用来判断计划过期没有）。
   * 2. 如果已经有一份计划在等审批，直接返回"已有计划在等"。
   * 3. 生成一个唯一的请求编号，把这条"计划审批请求"登记进待处理请求表，
   *    状态设为"等待中"（pending）。
   * 4. 把队友的计划状态设成"等待审批"，并把计划内容发给 lead。
   *
   * 返回一段文字，告诉队友"计划已提交，等 lead 决定"。
   */
  submitPlan(fromName: string, plan: string): string {
    const assignment = this.assignments.get(fromName);
    const taskId = assignment ? assignment.taskId : null;
    const workVersion = this.assignmentVersions.get(fromName) ?? 0;
    if (this.planGates.get(fromName) === "pending") {
      return "A plan is already waiting for review.";
    }
    const requestId = this.newRequestId();
    this.pendingRequests.set(requestId, {
      requestId,
      type: "plan_approval",
      sender: fromName,
      target: "lead",
      status: "pending",
      payload: plan,
      workVersion,
      taskId,
      createdAt: Date.now() / 1000,
    });
    this.planGates.set(fromName, "pending");
    this.planRequestIds.set(fromName, requestId);
    this.activeTeammates.set(fromName, "waiting_approval");
    this.bus.send(fromName, "lead", plan, "plan_approval_request", { request_id: requestId });
    return `Plan submitted (${requestId}). Wait for Lead's decision.`;
  }

  /**
   * 查某个队友的计划状态（比如：不用交计划、要交计划、等待审批、已批准、已拒绝）。
   *
   * 没记录过的话，默认当作"不用交计划"。
   */
  getPlanGate(name: string): string {
    return this.planGates.get(name) ?? "not_required";
  }

  /**
   * 设置某个队友的当前状态（比如 working 工作中、idle 空闲、waiting_approval 等待审批）。
   *
   * 这个状态记录在活跃队友表里，用来反映"这个队友现在在干嘛"。
   */
  setActive(name: string, status: string): void {
    this.activeTeammates.set(name, status);
  }

  /**
   * 处理一条"关闭请求"（lead 让某个队友收工）。
   *
   * 会做一整套校验，确保这条请求是真的、没有对错号：
   * - 消息是 lead 发的、是发给这个队友的。
   * - 请求编号在待处理表里、类型是"关闭"、发起人/收件人一致、还没处理过。
   * - 这个队友当前不是已经要关闭的状态。
   *
   * 校验通过，就把队友标成"stopping（正在关闭）"，返回 [true, 请求编号]；
   * 不通过，返回 [false, 忽略原因]。
   */
  applyShutdownRequest(name: string, msg: BusMessage): [boolean, string] {
    const requestId = String(msg.metadata["request_id"] ?? "");
    const state = this.pendingRequests.get(requestId);
    const valid =
      msg.from === "lead" &&
      msg.to === name &&
      state !== undefined &&
      state.type === "shutdown" &&
      state.sender === "lead" &&
      state.target === name &&
      state.status === "pending" &&
      this.activeTeammates.get(name) !== "stopping";
    if (!valid) return [false, "[Ignored shutdown request: request mismatch]"];
    this.activeTeammates.set(name, "stopping");
    return [true, requestId];
  }

  /**
   * 处理 lead 对某个计划的审批结果（批准或拒绝）。
   *
   * 同样先做一整套校验，防止把过期、对不上号的审批结果应用上去：
   * - 消息是 lead 发的、发给这个队友。
   * - 请求编号等于这个队友当前在等的那条计划请求。
   * - 这条请求的类型是"计划审批"、发起人/收件人一致。
   * - 请求里记的版本号和任务 id，跟队友"现在正在干的活"一致（保证计划没过期）。
   * - 审批结果是 approved 或 rejected，而且消息里的 approve 标记跟结果对得上。
   *
   * 校验通过，就把队友的计划状态更新成"已批准/已拒绝"，把它标回"工作中"，
   * 并返回 [true, 结果文字]；不通过返回 [false, 忽略原因]。
   */
  applyPlanResponse(name: string, msg: BusMessage): [boolean, string] {
    const requestId = String(msg.metadata["request_id"] ?? "");
    const [workVersion, taskId] = this.currentWorkIdentity(name);
    const state = this.pendingRequests.get(requestId);
    const expectedId = this.planRequestIds.get(name);
    const valid =
      msg.from === "lead" &&
      msg.to === name &&
      requestId === expectedId &&
      state !== undefined &&
      state.type === "plan_approval" &&
      state.sender === name &&
      state.target === "lead" &&
      state.workVersion === workVersion &&
      state.taskId === taskId &&
      (state.status === "approved" || state.status === "rejected") &&
      Boolean(msg.metadata["approve"]) === (state.status === "approved");
    if (!valid) return [false, "[Ignored plan response: request mismatch]"];
    this.planGates.set(name, state.status);
    this.activeTeammates.set(name, "working");
    this.planRequestIds.delete(name);
    const outcome = state.status;
    return [true, `[Plan ${outcome}] ${msg.content}`];
  }

  // ---- 协议（lead 侧） ----
  /**
   * 生成一个唯一的请求编号。
   *
   * 格式是 "req_" 开头 + 6 位随机数字（不足 6 位补零）。
   * 生成后检查一下待处理请求表里有没有重复，重复就重新生成，直到拿到一个没用的。
   */
  private newRequestId(): string {
    for (;;) {
      const requestId = `req_${Math.floor(Math.random() * 1000000)
        .toString()
        .padStart(6, "0")}`;
      if (!this.pendingRequests.has(requestId)) return requestId;
    }
  }

  /**
   * 创建并启动一个队友。
   *
   * 步骤：
   * 1. 校验名字：必须是 1~64 位的字母/数字/下划线/短横线；不能是保留名（lead、agent）；
   *    不能跟已有的队友重名。
   * 2. 把它登记进活跃队友表，初始状态"工作中"；根据要不要交计划，设置计划状态；
   *    版本号从 0 开始。
   * 3. 如果指定了初始任务，就让它认领这个任务；认领失败就回滚（把刚登记的记录删掉），
   *    返回失败原因。
   * 4. 创建一个 TeammateRuntime（队友运行器）并启动它，让它在后台开始干活。
   *
   * 返回一段文字，说明队友已创建、以及它带没带初始任务。
   */
  spawnTeammate(name: string, role: string, prompt: string, taskId?: string, requirePlan = false): string {
    if (!isValidAgentName(name)) {
      return "Invalid teammate name: use 1-64 letters, digits, underscores, or dashes";
    }
    if (RESERVED_TEAMMATE_NAMES.has(name.toLowerCase())) {
      return `Invalid teammate name: '${name}' is reserved by the runtime`;
    }
    if ([...this.activeTeammates.keys()].some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      return `Teammate '${name}' already exists`;
    }
    this.activeTeammates.set(name, "working");
    this.planGates.set(name, requirePlan ? "required" : "not_required");
    this.assignmentVersions.set(name, 0);
    if (taskId !== undefined) {
      const claimed = this.claimTask(name, taskId);
      if (!claimed.startsWith("Claimed ")) {
        this.activeTeammates.delete(name);
        this.planGates.delete(name);
        this.assignmentVersions.delete(name);
        return `Cannot spawn teammate '${name}': ${claimed}`;
      }
    }
    const runtime = new TeammateRuntime(
      name,
      role,
      prompt,
      taskId ?? null,
      requirePlan,
      this.provider,
      this.config,
      this.hooks,
      this.store,
      this,
    );
    void runtime.run();
    const assigned = taskId !== undefined ? ` for ${taskId}` : " without an initial Task";
    return `Teammate '${name}' spawned as ${role}${assigned}. End this turn; the runtime will deliver its events.`;
  }

  /**
   * 列出所有活跃队友，格式化成文本。
   *
   * 按名字字母顺序排序，每行一个，格式是"名字: 状态"。
   * 没有活跃队友就返回"No active teammates."。
   */
  listTeammates(): string {
    if (this.activeTeammates.size === 0) return "No active teammates.";
    return [...this.activeTeammates.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, status]) => `${name}: ${status}`)
      .join("\n");
  }

  /**
   * lead（领队）给某个活跃队友发一条消息。
   *
   * 先检查这个队友是否活跃，不活跃就返回提示；活跃就把消息发过去。
   */
  leadSendMessage(to: string, content: string): string {
    if (!this.activeTeammates.has(to)) return `Teammate '${to}' is not active`;
    this.bus.send("lead", to, content);
    return `Sent to ${to}`;
  }

  /**
   * lead 请求某个队友关闭（收工退出）。
   *
   * 先确认这个队友活跃，然后：
   * 1. 生成请求编号，登记一条"关闭请求"进待处理表，状态"等待中"。
   * 2. 给这个队友发一条关闭消息，让它"完成当前这一步然后收工"。
   *
   * 返回一段文字说明已发出关闭请求。
   */
  requestShutdown(teammate: string): string {
    if (!this.activeTeammates.has(teammate)) {
      return `Teammate '${teammate}' is not active`;
    }
    const requestId = this.newRequestId();
    this.pendingRequests.set(requestId, {
      requestId,
      type: "shutdown",
      sender: "lead",
      target: teammate,
      status: "pending",
      payload: "",
      workVersion: null,
      taskId: null,
      createdAt: Date.now() / 1000,
    });
    this.bus.send("lead", teammate, "Finish the current step and shut down.", "shutdown_request", {
      request_id: requestId,
    });
    return `Shutdown requested from ${teammate} (${requestId})`;
  }

  /**
   * lead 要求某个队友先提交计划（在动手之前先说明打算怎么做）。
   *
   * 先确认队友活跃，然后把它的计划状态设成"要交计划"，
   * 再发一条消息通知它"请先交计划"。
   */
  requestPlan(teammate: string, task: string): string {
    if (!this.activeTeammates.has(teammate)) {
      return `Teammate '${teammate}' is not active`;
    }
    this.planGates.set(teammate, "required");
    this.bus.send("lead", teammate, task, "plan_request");
    return `Plan requested from ${teammate}`;
  }

  /**
   * lead 审批（批准或拒绝）一份计划。
   *
   * 做一堆校验，保证审的是对的、没过期的计划：
   * - 请求编号存在、类型是"计划审批"、状态还是"等待中"。
   * - 这份计划对应的版本号和任务 id，跟提交人"现在正在干的活"一致。
   * - 这条计划确实是该队友当前最新的计划。
   *
   * 都通过后，把请求状态改成"已批准/已拒绝"，把审批结果（含反馈文字）发回给队友。
   * 返回一段文字说明审批结果。
   */
  reviewPlan(requestId: string, approve: boolean, feedback = ""): string {
    const state = this.pendingRequests.get(requestId);
    if (!state) return `Request ${requestId} not found`;
    if (state.type !== "plan_approval") return `Request ${requestId} is not a plan`;
    if (state.status !== "pending") return `Request ${requestId} already ${state.status}`;
    const [workVersion, taskId] = this.currentWorkIdentity(state.sender);
    if (state.workVersion !== workVersion || state.taskId !== taskId) {
      return `Request ${requestId} belongs to an earlier assignment`;
    }
    if (this.planRequestIds.get(state.sender) !== requestId) {
      return `Request ${requestId} is not the current plan`;
    }
    state.status = approve ? "approved" : "rejected";
    const sender = state.sender;
    const content = feedback || (approve ? "Plan approved." : "Revise the plan and submit it again.");
    this.bus.send("lead", sender, content, "plan_approval_response", {
      request_id: requestId,
      approve,
    });
    return `Plan ${state.status} (${requestId})`;
  }

  /**
   * 为某个任务创建并绑定一个"工作树"（worktree）。
   *
   * 工作树可以理解成：给这个任务单独准备的一个独立工作目录，
   * 让任务在里面隔离地干活，互不干扰。具体逻辑交给 worktree 模块。
   */
  createWorktree(name: string, taskId: string): string {
    return createWorktreeOp(this.store, this.workdir, this.worktreesDir, name, taskId);
  }

  // ---- lead 收件箱消费 ----
  /**
   * 读取 lead 的收件箱，把团队里的动态"翻译"进主对话。
   *
   * 做两件事：
   * 1. 先扫一遍消息，凡是"响应"类消息（比如计划审批结果、关闭响应），
   *    就用 matchResponse 去跟待处理请求对上号，更新请求状态。
   * 2. 如果确实有新消息，就把它们格式化成一段文字，作为一条"用户消息"塞进主对话，
   *    让主智能体（lead）能看到队友们都干了啥。
   *
   * 返回处理了多少条消息。
   */
  consumeAndInjectTeam(messages: ChatMessage[]): number {
    const msgs = this.bus.readInbox("lead");
    for (const msg of msgs) {
      const requestId = msg.metadata["request_id"];
      if (typeof requestId === "string" && requestId && msg.type.endsWith("_response")) {
        this.matchResponse(msg.type, requestId, Boolean(msg.metadata["approve"]), msg.from, msg.to);
      }
    }
    if (msgs.length === 0) return 0;
    messages.push({ role: "user", content: this.formatTeamEvents(msgs) });
    return msgs.length;
  }

  /**
   * 把一条"响应消息"跟某个待处理请求对上号，对上了就更新那条请求的状态。
   *
   * 校验：
   * - 请求编号在待处理表里。
   * - 响应类型跟请求类型匹配（关闭请求对应关闭响应，计划审批对应审批响应）。
   * - 消息的收发双方对得上（响应者是请求的接收方，收消息的是请求的发起方）。
   * - 请求状态还是"等待中"（已经处理过的就不再改）。
   *
   * 都通过，就把请求状态改成"已批准"或"已拒绝"（看 approve 是 true 还是 false）。
   */
  private matchResponse(
    responseType: string,
    requestId: string,
    approve: boolean,
    fromAgent: string,
    toAgent: string,
  ): void {
    const state = this.pendingRequests.get(requestId);
    if (!state) return;
    const expected = state.type === "shutdown" ? "shutdown_response" : "plan_approval_response";
    if (responseType !== expected) return;
    if (fromAgent !== state.target || toAgent !== state.sender) return;
    if (state.status !== "pending") return;
    state.status = approve ? "approved" : "rejected";
  }

  /**
   * 把一组团队消息格式化成一段给主智能体看的文字。
   *
   * 每条消息一行，格式是"[消息类型 请求编号] 发送者: 内容"，
   * 最后在最前面加一行"[Team events]"作为标题。
   */
  private formatTeamEvents(msgs: BusMessage[]): string {
    const lines = msgs.map((msg) => {
      const requestId = msg.metadata["request_id"];
      const suffix = typeof requestId === "string" && requestId ? ` request_id=${requestId}` : "";
      return `[${msg.type}${suffix}] ${msg.from}: ${msg.content}`;
    });
    return "[Team events]\n" + lines.join("\n");
  }
}
