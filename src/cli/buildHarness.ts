import * as path from "node:path";
import { loadConfig } from "../core/config.js";
import { ContextCompactor } from "../compaction/compactor.js";
import { registerCompactTool } from "../compaction/compactTool.js";
import { Harness } from "../core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../core/hooks.js";
import { createProvider } from "../providers/registry.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/index.js";
import {
  DEFAULT_RULES,
  SKIP_PERMISSIONS_RULES,
  insertUserRule,
  type PermissionRule,
} from "../security/rules.js";
import { makePermissionHook, type ApprovalAsker } from "../security/approval.js";
import { TaskStore } from "../planning/tasks.js";
import { TodoManager } from "../planning/todo.js";
import { registerPlanningTools } from "../planning/tools.js";
import { MemoryStore } from "../memory/store.js";
import { Memory } from "../memory/system.js";
import { BackgroundManager } from "../jobs/background.js";
import { CronScheduler } from "../jobs/cron.js";
import { JobsRuntime } from "../jobs/runtime.js";
import { registerJobsTools } from "../jobs/tools.js";
import { MessageBus } from "../agents/bus.js";
import { SubagentRunner } from "../agents/subagent.js";
import { TeamRuntime } from "../agents/team.js";
import { registerAgentTools } from "../agents/tools.js";
import { SkillLoader } from "../extensions/skills.js";
import { MCPRegistry } from "../extensions/mcp.js";
import type { McpServerConfig } from "../core/types.js";
import { registerExtensionTools } from "../extensions/tools.js";
import { Extensions } from "../extensions/index.js";
import { PromptGoalEvaluator } from "../goals/evaluator.js";
import { GoalController } from "../goals/controller.js";
import { OpenAIWorkflowRunner } from "../workflow/runtime.js";
import { WORKFLOWS } from "../workflow/registry.js";
import { registerWorkflowTools } from "../workflow/tools.js";
import { initLogger, createLogger } from "@blh/logger";
import { Tracer } from "../tracing/tracer.js";

const log = createLogger("cli.buildHarness");

/** 连接配置里声明的一个 MCP 服务器，把结果打到日志里（供启动时后台自动连接使用）。 */
async function connectConfiguredMcp(mcp: MCPRegistry, server: McpServerConfig): Promise<void> {
  const result = server.url
    ? await mcp.connectHttp(server.name, server.url, server.headers)
    : server.command
      ? await mcp.connect(server.name, server.command, server.args)
      : `Error: MCP server '${server.name}' has neither url nor command`;
  log.info(result);
}

/**
 * 构建一个完整的 Harness（运行核心），把 CLI 用到的所有子系统按依赖顺序组装起来。
 *
 * 一句话概括：这个函数是「装配车间」，先创建底层依赖（配置、日志、模型、工具、权限），
 * 再依次创建规划、记忆、定时任务、压缩、多智能体、扩展、工作流、目标等子系统，
 * 最后把它们全部塞进 Harness 返回。
 *
 * @param workdir 工作目录（可选）。决定配置、记忆、任务等文件都落在哪个目录下。
 * @param cli 来自命令行的配置覆盖项（可选）。用于覆盖默认配置，比如模型名、超时时间等。
 * @param askUser 权限审批回调（可选）。当某次工具调用需要用户确认时，用这个回调询问用户。
 * @param skipPermissions 是否跳过所有权限检查（默认 false）。为 true 时使用「全部放行」的规则集。
 * @param opts 额外选项：
 *  - userRules：用户自定义的权限规则列表，会被插入到默认规则中；
 *  - persistRule：当用户新批准一条规则时，用于把这条规则持久化保存的回调。
 */
export function buildHarness(
  workdir?: string,
  cli?: Record<string, unknown>,
  askUser?: ApprovalAsker,
  skipPermissions = false,
  opts?: {
    userRules?: PermissionRule[];
    persistRule?: (rule: PermissionRule) => void;
    approvalSource?: "cli" | "web";
  },
): Harness {
  // 加载配置：合并工作目录、CLI 参数等，得到一份统一配置。
  const config = loadConfig(workdir, cli);
  // 初始化日志系统：让后续所有日志都写入工作目录下统一管理。
  initLogger(config.workdir);
  // 创建 tracer：全链路事件落盘到 <workdir>/.blh/traces，失败静默不影响主流程。
  const tracer = new Tracer(config.workdir);

  // 创建模型提供者：按 config.provider 走对应厂商适配器（这是所有「用模型」能力的底层）。
  const provider = createProvider(config);

  // 创建工具注册表：集中登记所有可供模型调用的工具。
  const tools = new ToolRegistry();
  // 创建钩子总线：在关键节点（比如工具执行前）触发回调，实现权限拦截等功能。
  const hooks = new HookBus();

  // 注册内置工具：bash、文件读写、glob 搜索等基础工具。
  registerBuiltinTools(tools, config);

  // 组装权限规则：跳过权限模式用「全部放行」规则，否则用默认规则。
  const base = skipPermissions ? SKIP_PERMISSIONS_RULES : DEFAULT_RULES;
  const rules = [...base];
  // 把用户自定义规则插入到规则列表里（自定义规则优先级更高）。
  for (const r of opts?.userRules ?? []) insertUserRule(rules, r);

  // 创建权限拦截钩子，并挂到「工具执行前」这个节点上。
  // 这样每次模型想调用工具时，都会先经过权限校验，按规则放行或询问用户。
  const permissionHook = makePermissionHook(rules, askUser, opts?.persistRule, tracer, opts?.approvalSource ?? "cli");
  hooks.register(PRE_TOOL_USE, (payload) => permissionHook(payload.name, payload.input));

  // 注册上下文压缩工具：给模型一个能主动触发压缩历史对话的工具。
  registerCompactTool(tools);

  // 创建待办清单管理器：管理模型列出的待办事项（todo）。
  const todoManager = new TodoManager();
  // 创建任务存储：把结构化任务持久化到 .tasks 目录。
  const taskStore = new TaskStore(path.join(config.workdir, ".tasks"));
  // 注册规划相关工具：让模型能增删改查待办和任务。
  registerPlanningTools(tools, todoManager, taskStore);

  // 创建记忆系统：负责「读记忆（召回）」和「写记忆（提取）」。
  // 记忆数据落在 .memory 目录下，用同一个 provider 来做召回/提取时的模型调用。
  const memory = new Memory(new MemoryStore(path.join(config.workdir, ".memory")), provider, tracer);

  // 创建定时任务调度器，并从磁盘恢复之前保存的定时任务。
  const cron = new CronScheduler(path.join(config.workdir, ".scheduled_tasks.json"));
  cron.load();
  // 注册后台任务/定时任务相关工具。
  registerJobsTools(tools, cron);

  // 创建任务运行时：统一管理后台任务（长命令）、定时任务，并提供一个异步互斥锁（agentLock）。
  const jobs = new JobsRuntime(
    new BackgroundManager(config.workdir, config.bashTimeout, config.maxOutputChars),
    cron,
  );

  // 创建上下文压缩器：当对话过长时，把历史总结、把大工具结果落盘，避免撑爆上下文。
  const compactor = new ContextCompactor({
    provider,
    toolResultsDir: path.join(config.workdir, ".task_outputs", "tool-results"),
    tracer,
  });

  // 创建多智能体团队运行时：支持派生「队友」智能体协作，通过消息总线互相通信、审批计划。
  const agents = new TeamRuntime(
    taskStore,
    new MessageBus(path.join(config.workdir, ".mailboxes")),
    jobs.agentLock,
    config.workdir,
    path.join(config.workdir, ".worktrees"),
    provider,
    config,
    hooks,
  );

  // 创建子智能体运行器：跑一个一次性、带独立上下文的嵌套任务，只返回最终文本。
  const subagent = new SubagentRunner(provider, config, hooks, tracer);
  // 注册智能体相关工具：让主智能体能派生子智能体、管理队友等。
  registerAgentTools(tools, subagent, agents);

  // 创建技能加载器：从 skills 目录加载可复用的「技能」定义。
  const skills = new SkillLoader(path.join(config.workdir, "skills"));
  // 创建 MCP 注册表：接入外部 MCP 服务器提供的工具。
  const mcp = new MCPRegistry(tools, config.workdir);
  // 注册扩展相关工具：让模型能调用技能和 MCP 提供的能力。
  registerExtensionTools(tools, skills, mcp);
  // 启动时自动连接配置文件里声明的 MCP 服务器（后台进行，不阻塞启动流程）。
  for (const server of config.mcpServers ?? []) {
    void connectConfiguredMcp(mcp, server);
  }

  // 创建扩展聚合对象：把技能和 MCP 包装成统一入口，方便 Harness 使用。
  const extensions = new Extensions(skills, mcp);

  // 创建工作流运行时存储目录，并注册工作流相关工具。
  // 工作流允许把多个模型调用编排成多阶段流程。
  const workflowStore = path.join(config.workdir, ".workflow_runtime");
  registerWorkflowTools(tools, workflowStore, () => new OpenAIWorkflowRunner(provider), WORKFLOWS, tracer);

  // 创建目标控制器：跟踪当前目标，并在每轮结束后用模型判断目标是否已达成。
  const goal = new GoalController(new PromptGoalEvaluator(provider));

  // 把所有子系统汇总成一个 Harness 返回，作为整个程序的运行入口。
  return new Harness(config, provider, tools, hooks, compactor, todoManager, memory, jobs, agents, extensions, goal, workflowStore, tracer);
}
