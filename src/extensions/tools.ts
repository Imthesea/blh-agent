import type { ToolRegistry } from "../tools/registry.js";
import type { SkillLoader } from "./skills.js";
import type { MCPRegistry } from "./mcp.js";

export function registerExtensionTools(
  registry: ToolRegistry,
  skills: SkillLoader,
  mcp: MCPRegistry,
): void {
  registry.register({
    name: "load_skill",
    description: "Load the full SKILL.md content by skill name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args) => skills.load(typeof args.name === "string" ? args.name : ""),
  });

  registry.register({
    name: "connect_mcp",
    description:
      "Connect to an MCP server and discover its tools. " +
      "For a local server, provide command (and optional args). " +
      "For a remote HTTP server, provide url (and optional headers for auth, e.g. Authorization).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["name"],
    },
    handler: (args) => {
      const name = typeof args.name === "string" ? args.name : "";
      const url = typeof args.url === "string" ? args.url : "";
      // 有 url 就走远程 HTTP 连接，否则走本地 stdio 连接。
      if (url) {
        const headers = args.headers;
        const headerObj: Record<string, string> = {};
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          for (const [k, v] of Object.entries(headers)) {
            headerObj[k] = String(v);
          }
        }
        return mcp.connectHttp(name, url, headerObj);
      }
      return mcp.connect(
        name,
        typeof args.command === "string" ? args.command : "",
        Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : undefined,
      );
    },
  });
}
