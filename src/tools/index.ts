import type { Config } from "../core/types.js";
import type { ToolRegistry } from "./registry.js";
import { readFile, writeFile, editFile } from "./files.js";
import { runBash } from "./bash.js";
import { glob } from "./glob.js";

export function registerBuiltinTools(registry: ToolRegistry, config: Config): void {
  const workdir = config.workdir;

  registry.register({
    name: "bash",
    description: "Execute a shell command in the workdir",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120)" },
        run_in_background: { type: "boolean" },
      },
      required: ["command"],
    },
    handler: (args, signal) => runBash(workdir, config.bashTimeout, config.maxOutputChars, args, signal),
  });

  registry.register({
    name: "read_file",
    description: "Read a file with line numbers",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workdir)" },
        start: { type: "number", description: "Start line offset (0-based)" },
        limit: { type: "number", description: "Max lines to read" },
      },
      required: ["path"],
    },
    handler: (args) => readFile(workdir, args),
  });

  registry.register({
    name: "write_file",
    description: "Write content to a file (creates parent directories)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workdir)" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    handler: (args) => writeFile(workdir, args),
  });

  registry.register({
    name: "edit_file",
    description: "Replace a unique occurrence of old_text with new_text",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workdir)" },
        old_text: { type: "string", description: "Text to replace (must occur exactly once)" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
    handler: (args) => editFile(workdir, args),
  });

  registry.register({
    name: "glob",
    description: "Find files matching a pattern (relative paths, max 200)",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. *.ts" },
      },
      required: ["pattern"],
    },
    handler: (args) => glob(workdir, args),
  });
}
