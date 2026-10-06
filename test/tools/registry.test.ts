import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/contracts/types.js";

function echoTool(): ToolDefinition {
  return {
    name: "echo",
    description: "echo back the text",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async (args) => String(args.text),
  };
}

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());
    expect(registry.list().map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("dispatches to the handler", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());
    await expect(registry.dispatch("echo", { text: "hello" })).resolves.toBe("hello");
  });

  it("returns error string for unknown tool", async () => {
    const registry = new ToolRegistry();
    await expect(registry.dispatch("nope", {})).resolves.toBe("error: unknown tool 'nope'");
  });

  it("returns error string when handler throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...echoTool(),
      name: "boom",
      handler: async () => {
        throw new Error("kaput");
      },
    });
    await expect(registry.dispatch("boom", {})).resolves.toBe(
      "error: tool 'boom' failed: kaput",
    );
  });

  it("returns error string for invalid arguments", async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...echoTool(),
      name: "strict",
      handler: async (args) => {
        if (typeof args.text !== "string") throw new TypeError("text must be a string");
        return args.text;
      },
    });
    await expect(registry.dispatch("strict", { text: 42 })).resolves.toBe(
      "error: invalid tool arguments: text must be a string",
    );
  });
});
