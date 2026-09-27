/** 可插拔 provider 的唯一标识（内置 deepseek/anthropic/qwen/kimi，也允许自定义字符串）。 */
export type ProviderId = string;

/** provider 底层走的 API 协议：openai 兼容 or 原生 anthropic。 */
export type ProviderApi = "openai" | "anthropic";

/** 一个 provider 的静态描述：谁（id/name）+ 怎么（api）+ 默认连接参数。 */
export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  apiKeyEnv: string[];
  defaultModel: string;
}

/** 一次工具调用的描述：模型想调用哪个函数、传什么参数 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 与模型交互的一条消息（对齐 OpenAI chat.completions） */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** 该条 assistant 消息是否因用户中断而提前结束 */
  cancelled?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;

/** 工具参数 JSON Schema 属性（递归，支持 enum / array items / 嵌套 object） */
export type JsonSchemaProperty = {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: JsonSchemaProperty;
};

/** 工具参数的 JSON Schema，整体必须是一个 object */
export type ToolParameters = {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

/** 一个可供模型调用的工具：名字、参数说明，以及真正执行的处理函数 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  handler: ToolHandler;
}

/** 配置文件里声明的单个 MCP 服务器：本地 stdio（command+args）或远程 HTTP（url+headers）二选一 */
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

/** 运行配置：模型、工作目录、bash 超时和输出长度上限等 */
export interface Config {
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** provider id（deepseek/anthropic/qwen/kimi…）；loadConfig 必填，测试替身可省略由 createProvider 兜底 deepseek */
  provider?: string;
  workdir: string;
  bashTimeout: number;
  maxOutputChars: number;
  /** 启动时自动连接的 MCP 服务器列表（来自配置文件的 mcp_servers） */
  mcpServers?: McpServerConfig[];
}

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): Promise<ChatMessage>;
  stream?(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  /** 无 tools 单轮并返回 usage（供 workflow 记账）。可选：未实现时 workflow 不可用。 */
  chatCompletion?(messages: ChatMessage[], maxTokens?: number): Promise<{ message: ChatMessage; usage: ChatUsage }>;
  /** 最近一次 chat()/chatCompletion() 的 token 用量（非流式路径记账用）；未实现或未调用时返回 undefined。 */
  lastUsage?(): ChatUsage | undefined;
}

/** 一次 LLM 调用的 token 用量 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Provider 底层流事件：text/tool_call 是增量，done 是拼好的完整消息 */
export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; message: ChatMessage; usage?: ChatUsage };
