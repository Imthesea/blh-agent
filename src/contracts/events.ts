/** agentLoop 对外产出的高层事件：文本增量、工具进度与轮次边界。 */
export type AgentEvent =
  /** 一轮对话开始，无需渲染任何东西。 */
  | { type: "turn_start" }
  /** 模型流式输出的一段文字增量，直接原样写终端。 */
  | { type: "assistant_text_delta"; text: string }
  /** 流式中断后由非流式兜底的完整回复，整体打印。 */
  | { type: "assistant_text_complete"; text: string }
  /** 模型要调用工具：id 是调用标识，name 是工具名，arguments 是序列化后的参数。 */
  | { type: "tool_call"; id: string; name: string; arguments: string }
  /** 工具执行结果：output 是输出内容，isError 标记是否执行出错。 */
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  /** 一轮对话被取消（如用户中断），text 是取消说明。 */
  | { type: "turn_cancelled"; text: string }
  /** 一轮对话结束，收尾未闭合的文本输出。 */
  | { type: "turn_end" };
