import type { ChatProvider, Config } from "../src/contracts/types.js";
import { Harness } from "../src/runtime/harness.js";
import { HookBus } from "../src/runtime/hooks.js";
import { PRE_TOOL_USE } from "../src/contracts/hooks.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { registerBuiltinTools } from "../src/tools/index.js";
import { DEFAULT_RULES } from "../src/security/rules.js";
import { makePermissionHook } from "../src/security/approval.js";
import { submitResultTool } from "./submit-result.js";
import type { EvalCase } from "./check.js";

/**
 * safe 策略下从内置工具里剔除的逃逸向量：shell。
 * shell 可以读 env（偷 key）、访问网络、越权删文件，是未沙箱时最大的口子。
 * agent/planning/workflow 等派生类工具本来就不在这个最小 harness 里注册，无需再列。
 */
export const SANDBOX_FORBIDDEN_TOOLS = new Set(["bash"]);

export type SandboxPolicy = "safe" | "full";

export interface SandboxOptions {
  policy?: SandboxPolicy;
  /** 额外禁用的工具（在 safe 禁用集之外，供测试/消融按需关闭某工具）。 */
  disabledTools?: readonly string[];
}

/** 评测专用系统提示词：不提未注册的工具（spawn_teammate/create_task/schedule_cron/todo_write 等）。 */
function evalSystemPrompt(config: Config): string {
  return (
    `你是 blh，一个编程智能体。工作目录：${config.workdir}。 ` +
    "使用提供的工具替用户办事。 " +
    "完成后，简要总结你做了什么。 " +
    "始终用简体中文回复，除非用户明确要求其他语言。"
  );
}

/**
 * 评测用最小 harness：内置文件工具（read/write/edit/glob）+ submit_result。
 * safe 策略去掉 bash，配合 blh 的 safePath（文件只能读写 workdir 内）+ 每 run 独立 workdir，
 * 即可让 agent 读不到 judge/fixtures、无 shell/网络、不污染主机。
 */
export function createSandboxHarness(
  config: Config,
  provider: ChatProvider,
  options: SandboxOptions = {},
): Harness {
  const policy = options.policy ?? "safe";
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, config);
  tools.register(submitResultTool());
  if (policy === "safe") {
    for (const name of SANDBOX_FORBIDDEN_TOOLS) tools.unregister(name);
  }
  for (const name of options.disabledTools ?? []) tools.unregister(name);
  const hooks = new HookBus();
  const permissionHook = makePermissionHook(DEFAULT_RULES, async () => "allow");
  hooks.register(PRE_TOOL_USE, (payload) => permissionHook(payload.name, payload.input));
  return new Harness(
    config,
    provider,
    tools,
    hooks,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    evalSystemPrompt(config),
  );
}

/** 该用例的期望是否引用了 safe 策略下被禁用的工具（用于提示需要 full 策略）。 */
export function caseNeedsFullTools(evalCase: EvalCase): boolean {
  const tools = new Set(evalCase.expect_tools ?? []);
  for (const tool of Object.keys(evalCase.expect_in_args ?? {})) tools.add(tool);
  for (const tool of Object.keys(evalCase.expect_min_tool_calls ?? {})) tools.add(tool);
  for (const tool of Object.keys(evalCase.expect_max_tool_calls ?? {})) tools.add(tool);
  return [...tools].some((tool) => SANDBOX_FORBIDDEN_TOOLS.has(tool));
}