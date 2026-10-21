import type { ToolDefinition } from "../contracts/types.js";
import { TOOL_ERROR_PREFIX } from "@blh/web-protocol";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `${TOOL_ERROR_PREFIX} unknown tool '${name}'`;
    try {
      return await tool.handler(args, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError) return `${TOOL_ERROR_PREFIX} invalid tool arguments: ${message}`;
      return `${TOOL_ERROR_PREFIX} tool '${name}' failed: ${message}`;
    }
  }
}
