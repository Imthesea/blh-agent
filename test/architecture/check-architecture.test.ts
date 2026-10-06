import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

type ExecError = {
  code?: number | string;
  stderr?: string;
};

describe("architecture guard", () => {
  it("rejects new reverse and feature-to-feature dependencies", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "architecture-guard-"));
    const sourceRoot = path.join(root, "src");
    const configPath = path.join(root, "architecture.json");
    try {
      mkdirSync(path.join(sourceRoot, "contracts"), { recursive: true });
      mkdirSync(path.join(sourceRoot, "runtime"), { recursive: true });
      mkdirSync(path.join(sourceRoot, "agents"), { recursive: true });
      mkdirSync(path.join(sourceRoot, "memory"), { recursive: true });
      mkdirSync(path.join(sourceRoot, "cli"), { recursive: true });

      writeFileSync(
        path.join(sourceRoot, "contracts", "types.ts"),
        'import type { Foo } from "../agents/foo.js";\nexport type { Foo };\n',
      );
      writeFileSync(
        path.join(sourceRoot, "runtime", "loop.ts"),
        'import type { Foo } from "../agents/foo.js";\nexport type { Foo };\n',
      );
      writeFileSync(
        path.join(sourceRoot, "agents", "agent.ts"),
        'import type { Foo } from "../memory/foo.js";\nexport type { Foo };\n',
      );
      writeFileSync(
        path.join(sourceRoot, "cli", "main.ts"),
        'import type { Foo } from "../memory/foo.js";\nexport type { Foo };\n',
      );
      writeFileSync(
        configPath,
        JSON.stringify({
          featureDirectories: ["agents", "memory"],
          sharedDirectories: [],
          compositionRoot: "cli",
          allowedFeatureEdges: [],
        }),
      );

      const error = (await run(process.execPath, [
        "scripts/check-architecture.mjs",
        "--root",
        sourceRoot,
        "--config",
        configPath,
      ], { cwd: repoRoot }).catch((execError: unknown) => execError as ExecError)) as ExecError;
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("Architecture violations:");
      expect(error.stderr).toContain("contracts cannot import agents");
      expect(error.stderr).toContain("runtime cannot import agents");
      expect(error.stderr).toContain("agents cannot import memory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the project architecture baseline", async () => {
    const { stdout, stderr } = await run(process.execPath, ["scripts/check-architecture.mjs"], {
      cwd: repoRoot,
    });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
