import type { ToolRegistry } from "../tools/registry.js";
import type { CronJob, CronScheduler } from "./cron.js";

/**
 * 格式化"已成功调度一个定时任务"的提示信息。
 *
 * 当用户通过 schedule_cron 工具成功创建了一个定时任务后，
 * 此函数会把任务的关键信息（任务 ID、cron 表达式、要执行的提示词）
 * 拼成一行可读的字符串返回给用户。
 *
 * @param job 刚被调度成功的定时任务对象
 * @returns 形如 "Scheduled <id>: <cron> -> <prompt>" 的提示文本
 */
function scheduled(job: CronJob): string {
  return `Scheduled ${job.id}: ${job.cron} -> ${job.prompt}`;
}

/**
 * 格式化"定时任务列表"的展示文本。
 *
 * 当用户通过 list_crons 工具查看当前所有已调度的定时任务时，
 * 此函数会把每个任务逐行列出，每行包含：
 *   任务 ID、cron 表达式、提示词前 60 个字符，以及两项标签：
 *   - frequency（执行频率）：recurring 表示循环执行，one-shot 表示仅执行一次
 *   - storage（存储方式）：durable 表示持久化存储（跨会话保留），session 表示仅当前会话有效
 *
 * @param jobs 当前所有的定时任务数组
 * @returns 多行文本；若列表为空则返回 "No cron jobs."
 */
function listed(jobs: CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs.";
  return jobs
    .map((job) => {
      const frequency = job.recurring ? "recurring" : "one-shot";
      const storage = job.durable ? "durable" : "session";
      return `${job.id}: ${job.cron} -> ${job.prompt.slice(0, 60)} [${frequency}, ${storage}]`;
    })
    .join("\n");
}

/**
 * 注册与定时任务相关的三个工具到工具注册表。
 *
 * 本函数把定时任务（cron）的调度、查看、取消三种能力
 * 以"工具"的形式暴露出去，供上层调用（通常是 AI 智能体调用这些工具）。
 *
 * @param registry 工具注册表，负责收集并统一管理所有可用工具
 * @param scheduler 定时任务调度器，实际负责任务的创建、查询与取消
 */
export function registerJobsTools(registry: ToolRegistry, scheduler: CronScheduler): void {
  // 工具一：schedule_cron —— 调度一个新的定时任务
  registry.register({
    name: "schedule_cron",
    description: "Schedule a prompt with a 5-field cron expression.",
    parameters: {
      type: "object",
      properties: {
        cron: { type: "string" },        // 5 段式 cron 表达式，决定任务何时触发
        prompt: { type: "string" },      // 任务触发时要执行的提示词内容
        recurring: { type: "boolean" },  // 是否循环执行；缺省为 true（循环）
        durable: { type: "boolean" },    // 是否持久化存储；缺省为 true（持久化）
      },
      required: ["cron", "prompt"],      // cron 与 prompt 为必填参数
    },
    handler: async (args) =>
      // 调度任务，并把结果交给 scheduled 函数格式化为可读文本返回
      scheduled(
        scheduler.schedule(
          String(args["cron"] ?? ""),
          String(args["prompt"] ?? ""),
          // recurring 仅在显式传 false 时才视为"单次执行"，否则默认循环
          args["recurring"] !== false,
          // durable 仅在显式传 false 时才视为"仅会话有效"，否则默认持久化
          args["durable"] !== false,
        ),
      ),
  });

  // 工具二：list_crons —— 列出当前所有已调度的定时任务
  registry.register({
    name: "list_crons",
    description: "List scheduled cron jobs.",
    parameters: { type: "object", properties: {} }, // 无参数
    handler: async () => listed(scheduler.listJobs()), // 取回任务列表并格式化为文本
  });

  // 工具三：cancel_cron —— 按任务 ID 取消一个定时任务
  registry.register({
    name: "cancel_cron",
    description: "Cancel a cron job by ID.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } }, // 要取消的任务 ID
      required: ["job_id"],                       // job_id 为必填参数
    },
    handler: async (args) => scheduler.cancel(String(args["job_id"] ?? "")), // 调用调度器执行取消
  });
}
