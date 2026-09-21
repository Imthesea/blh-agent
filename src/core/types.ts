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
  workdir: string;
  bashTimeout: number;
  maxOutputChars: number;
  /** 启动时自动连接的 MCP 服务器列表（来自配置文件的 mcp_servers） */
  mcpServers?: McpServerConfig[];
}

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): Promise<ChatMessage>;
  stream?(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
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
