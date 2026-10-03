import type { ToolRegistry } from "../tools/registry.js";

/** task 工具的后端：一次性 subagent。 */
export interface SubagentLike {
  run(prompt: string, signal?: AbortSignal): Promise<string>;
}

/** Lead 团队工具所需的最小 TeamRuntime 接口。 */
export interface TeamToolsLike {
  spawnTeammate(name: string, role: string, prompt: string, taskId?: string, requirePlan?: boolean): string;
  listTeammates(): string;
  leadSendMessage(to: string, content: string): string;
  requestShutdown(teammate: string): string;
  requestPlan(teammate: string, task: string): string;
  reviewPlan(requestId: string, approve: boolean, feedback?: string): string;
  createWorktree(name: string, taskId: string): string;
}

/** agents 工具注册：task + 7 个 Lead 团队工具。 */
export function registerAgentTools(
  registry: ToolRegistry,
  subagent: SubagentLike,
  team: TeamToolsLike,
): void {
  registry.register({
    name: "task",
    description: "用全新上下文跑一个子智能体，返回它的最终文本。",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    handler: async (args, signal) => subagent.run(String(args["prompt"] ?? ""), signal),
  });
  registry.register({
    name: "spawn_teammate",
    description: "创建一个常驻的队友。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
        task_id: { type: "string" },
        require_plan: { type: "boolean" },
      },
      required: ["name", "role", "prompt"],
    },
    handler: async (args) =>
      team.spawnTeammate(
        String(args["name"] ?? ""),
        String(args["role"] ?? ""),
        String(args["prompt"] ?? ""),
        typeof args["task_id"] === "string" ? args["task_id"] : undefined,
        args["require_plan"] === true,
      ),
  });
  registry.register({
    name: "list_teammates",
    description: "列出当前活跃的队友。",
    parameters: { type: "object", properties: {} },
    handler: async () => team.listTeammates(),
  });
  registry.register({
    name: "send_message",
    description: "给一个队友发消息。",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, content: { type: "string" } },
      required: ["to", "content"],
    },
    handler: async (args) =>
      team.leadSendMessage(String(args["to"] ?? ""), String(args["content"] ?? "")),
  });
  registry.register({
    name: "request_shutdown",
    description: "让一个队友关闭。",
    parameters: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
    handler: async (args) => team.requestShutdown(String(args["teammate"] ?? "")),
  });
  registry.register({
    name: "request_plan",
    description: "要求某个队友先提交计划，才能改工作区。",
    parameters: {
      type: "object",
      properties: { teammate: { type: "string" }, task: { type: "string" } },
      required: ["teammate", "task"],
    },
    handler: async (args) =>
      team.requestPlan(String(args["teammate"] ?? ""), String(args["task"] ?? "")),
  });
  registry.register({
    name: "review_plan",
    description: "批准或拒绝一份计划。",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
    handler: async (args) =>
      team.reviewPlan(
        String(args["request_id"] ?? ""),
        args["approve"] === true,
        String(args["feedback"] ?? ""),
      ),
  });
  registry.register({
    name: "create_worktree",
    description: "为任务创建并绑定一个工作树。",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, task_id: { type: "string" } },
      required: ["name", "task_id"],
    },
    handler: async (args) =>
      team.createWorktree(String(args["name"] ?? ""), String(args["task_id"] ?? "")),
  });
}
