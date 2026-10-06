/** 用户提交了提示词（每次用户输入、开始一轮之前触发）。 */
export const USER_PROMPT_SUBMIT = "user_prompt_submit";
/** 工具被调用之前触发。 */
export const PRE_TOOL_USE = "pre_tool_use";
/** 工具调用结束之后触发。 */
export const POST_TOOL_USE = "post_tool_use";
/** 一轮对话收尾时触发。 */
export const STOP = "stop";

/** 事件名 → 载荷类型 的映射：register/trigger/firstBlock 靠它保证事件名和载荷类型一一对应。 */
export interface HookPayloads {
  [USER_PROMPT_SUBMIT]: { text: string };
  [PRE_TOOL_USE]: { name: string; input: Record<string, unknown> };
  [POST_TOOL_USE]: { name: string; input: Record<string, unknown>; output: string };
  [STOP]: Record<string, never>;
}

/** 事件的名称，就是 HookPayloads 里所有键。 */
export type HookEvent = keyof HookPayloads;

/** 一个钩子函数：接收对应事件的载荷，返回一个字符串或 null。 */
export type HookFn<E extends HookEvent = HookEvent> = (
  payload: HookPayloads[E],
) => Promise<string | null>;
