/** workflow 工具注册。 */
import type { ToolRegistry } from "../tools/registry.js";
import { runWorkflow } from "./tool.js";
import type { WorkflowRegistry, WorkflowRunner } from "./runtime.js";
import { WorkflowInputError } from "./schema.js";
import type { Tracer } from "../tracing/tracer.js";

export function registerWorkflowTools(
  registry: ToolRegistry,
  store: string,
  runnerFactory: () => WorkflowRunner,
  workflows: WorkflowRegistry,
  tracer?: Tracer,
): void {
  registry.register({
    name: "run_workflow",
    description: "Run a saved workflow by name. Pass input in args.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        args: { type: "object" },
        resume_from_run_id: { type: "string" },
      },
      required: ["name"],
    },
    handler: async (a) => {
      const name = typeof a.name === "string" ? a.name : "";
      const start = Date.now();
      tracer?.event("workflow", { workflow: name, stage: "run", status: "start" });
      try {
        const args =
          typeof a.args === "object" && a.args !== null && !Array.isArray(a.args)
            ? (a.args as Record<string, unknown>)
            : undefined;
        const resume = typeof a.resume_from_run_id === "string" ? a.resume_from_run_id : undefined;
        const result = await runWorkflow(name, args, resume, store, runnerFactory, workflows);
        const status = result.task.status === "failed" ? "error" : "ok";
        tracer?.event("workflow", { workflow: name, stage: "run", status, latency_ms: Date.now() - start });
        return JSON.stringify(result);
      } catch (error) {
        tracer?.event("workflow", { workflow: name, stage: "run", status: "error", latency_ms: Date.now() - start });
        if (error instanceof WorkflowInputError) return `Error: ${error.message}`;
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
