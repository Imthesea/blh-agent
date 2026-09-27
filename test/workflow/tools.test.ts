import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { MockWorkflowRunner } from "../../src/workflow/runtime.js";
import { WORKFLOWS } from "../../src/workflow/registry.js";
import { registerWorkflowTools } from "../../src/workflow/tools.js";
import { Tracer } from "../../src/tracing/tracer.js";

describe("registerWorkflowTools", () => {
  it("registers run workflow", () => {
    const registry = new ToolRegistry();
    const store = mkdtempSync(path.join(os.tmpdir(), "wf-tools-"));
    try {
      registerWorkflowTools(registry, store, () => new MockWorkflowRunner(), WORKFLOWS);
      expect(registry.list().map((tool) => tool.name)).toContain("run_workflow");
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("records workflow trace events (ok and error)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wf-trace-"));
    try {
      const tracer = new Tracer(dir);
      const registry = new ToolRegistry();
      registerWorkflowTools(registry, path.join(dir, ".workflow_runtime"), () => new MockWorkflowRunner(), WORKFLOWS, tracer);
      await registry.dispatch("run_workflow", { name: "review-changes", args: { changes: "x = 1" } });
      await registry.dispatch("run_workflow", { name: "no-such-workflow" });
      const tracesDir = path.join(dir, ".blh", "traces");
      const events = readdirSync(tracesDir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) =>
          readFileSync(path.join(tracesDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
        );
      expect(events[0]).toMatchObject({ type: "workflow", workflow: "review-changes", status: "start" });
      expect(events[1]).toMatchObject({ type: "workflow", workflow: "review-changes", status: "ok" });
      expect(events[2]).toMatchObject({ type: "workflow", workflow: "no-such-workflow", status: "start" });
      expect(events[3]).toMatchObject({ type: "workflow", workflow: "no-such-workflow", status: "error" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
