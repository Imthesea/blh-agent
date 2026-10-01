/**
 * 最小可用的 SWE-bench 评测 runner（只做「生成阶段」）。
 *
 * 流程：对每个 instance ——
 *   1. 把本地仓库 checkout 到 base_commit；
 *   2. 用 blh 的编程接口跑一轮（workdir 指向仓库目录，跳过权限）；
 *   3. 清理 blh 产生的运行时产物，再用 `git diff --cached` 提取 patch；
 *   4. 写到 predictions/<instance_id>.patch。
 *
 * 评测阶段（跑 fail-to-pass / pass-to-pass 测试打分）请交给官方 swebench 库：
 *   swebench run_evaluation --predictions_path predictions --dataset <jsonl> ...
 *
 * 前提假设：
 *   - 从【项目根目录】运行，保证能读到 .env 里的 API key；
 *   - 每个 repo 已经 clone 到本地，目录命名是 repo 字段把 "/" 换成 "__"
 *     （例如 "django/django" -> <repos>/django__django），且含完整历史（base_commit 是历史提交）。
 *
 * 用法：
 *   pnpm exec tsx scripts/swebench-run.ts --dataset <data.jsonl> --repos <仓库根目录> [--instance <id>] [--limit N] [--out predictions]
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { buildHarness } from "../src/cli/buildHarness.js";
import { lastAssistantText } from "../src/core/loop.js";

/** SWE-bench 数据集里我们用到的字段。 */
interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}

/**
 * blh 把 workdir 当工作目录时，会在其下创建这些运行时产物。
 * 提取 patch 前必须清掉，否则会被 `git add -A` 一起 stage 进补丁。
 */
const RUNTIME_ARTIFACTS = [
  ".tasks",
  ".memory",
  ".scheduled_tasks.json",
  ".mailboxes",
  ".worktrees",
  ".task_outputs",
  ".workflow_runtime",
  ".blh",
  ".sessions",
];

/** 统一的提示词包装：issue 描述 + 约束（只改代码、不提交）。 */
function wrapPrompt(issue: string): string {
  return [
    "You are an autonomous software engineer fixing an issue in this repository.",
    "",
    "<issue>",
    issue,
    "</issue>",
    "",
    "Fix the issue with minimal changes. Use bash to inspect files and run tests.",
    "Do not create commits, do not open PRs, and do not modify files outside the repository.",
  ].join("\n");
}

/** 读 jsonl 数据集，返回 instance 列表（跳过空行）。 */
function readInstances(datasetPath: string): SweInstance[] {
  const text = fs.readFileSync(datasetPath, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SweInstance);
}

/** repo 字段 "django/django" -> 本地目录 "<repos>/django__django"。 */
function repoDir(reposRoot: string, repo: string): string {
  return path.join(reposRoot, repo.replaceAll("/", "__"));
}

/** 在指定仓库执行 git 命令，返回 stdout 文本。 */
function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 把仓库复位到指定 commit 的干净状态（detached + 清改动 + 清未跟踪）。 */
function resetRepo(repo: string, commit: string): void {
  git(repo, ["checkout", "--detach", commit]);
  git(repo, ["reset", "--hard", commit]);
  git(repo, ["clean", "-fd"]);
}

/** 跑单个 instance：生成 patch 并落盘，返回写出的文件路径。 */
async function runOne(instance: SweInstance, reposRoot: string, outDir: string): Promise<string> {
  const repo = repoDir(reposRoot, instance.repo);

  // 1. 复位到干净的 base_commit。
  resetRepo(repo, instance.base_commit);

  // 2. 用 blh 跑一轮修复。workdir 指向仓库目录；skipPermissions=true 让 bash 自由跑。
  const harness = buildHarness(repo, { bash_timeout: "300" }, undefined, true);
  const messages = harness.newSession();
  await harness.runTurn(messages, wrapPrompt(instance.problem_statement));

  // 3. 清掉 blh 的运行时产物，只留下真正的代码改动。
  for (const artifact of RUNTIME_ARTIFACTS) {
    fs.rmSync(path.join(repo, artifact), { recursive: true, force: true });
  }

  // 4. 提取 patch：先 stage 全部改动（含新增文件），再 diff 已暂存内容。
  git(repo, ["add", "-A"]);
  const patch = git(repo, ["diff", "--cached"]);

  const outPath = path.join(outDir, `${instance.instance_id}.patch`);
  fs.writeFileSync(outPath, patch, "utf8");

  // 5. 复位仓库，为下一个 instance 留一个干净起点。
  resetRepo(repo, instance.base_commit);

  return outPath;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      repos: { type: "string" },
      instance: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });

  const datasetPath = values.dataset;
  const reposRoot = values.repos;
  if (!datasetPath || !reposRoot) {
    console.error("缺少必填参数：--dataset <data.jsonl> 和 --repos <仓库根目录>");
    process.exit(1);
  }

  const outDir = path.resolve(values.out ?? "predictions");
  fs.mkdirSync(outDir, { recursive: true });

  let instances = readInstances(datasetPath);
  if (values.instance) {
    instances = instances.filter((i) => i.instance_id === values.instance);
  }
  if (values.limit) {
    instances = instances.slice(0, Number.parseInt(values.limit, 10));
  }

  console.log(`共 ${instances.length} 个 instance，patch 输出到 ${outDir}`);

  for (const instance of instances) {
    console.log(`\n===== ${instance.instance_id} (${instance.repo} @ ${instance.base_commit.slice(0, 8)}) =====`);
    try {
      const outPath = await runOne(instance, reposRoot, outDir);
      console.log(`[${instance.instance_id}] OK -> ${outPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${instance.instance_id}] 失败: ${message}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
