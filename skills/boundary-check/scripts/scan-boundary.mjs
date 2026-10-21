#!/usr/bin/env node
// scan-boundary.mjs —— 扫描"无限膨胀"反模式。
// 零依赖，只读源码文本做静态匹配，结果全部是候选可疑点，需人工判断。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx", ".cjs", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", ".blh", ".sessions", ".transcripts",
  ".tasks", ".worktrees", ".mailboxes", ".pnpm-store", ".pnpm-cache", ".memory",
]);

// 每条规则对应 SKILL.md 5 步清单里的某一项。
const RULES = [
  {
    id: "full-read-sync",
    checklist: "读取",
    pattern: /\breadFileSync\s*\(/,
    suggestion: "全量同步读会把整个文件读进内存。追加型文件应改用 offset/cursor 增量读（参考 src/tracing/store.ts 的 JsonlTail）。",
  },
  {
    id: "full-read",
    checklist: "读取",
    pattern: /\breadFile\s*\(/,
    suggestion: "readFile 默认读全量。确认读的是不是只增不减的文件；若是，改用增量读。",
  },
  {
    id: "full-parse",
    checklist: "计算",
    pattern: /\bJSON\.parse\s*\(/,
    suggestion: "每次请求/轮询都全量 parse 会越用越慢。确认有结果缓存 + 脏标记，统计用增量累加器（参考 createUsageAccumulator）。",
  },
  {
    id: "poll",
    checklist: "展示",
    pattern: /\bsetInterval\s*\(/,
    suggestion: "定时轮询若每次拉全量并整页重画，会随数据量变卡。确认是增量轮询，且数据没变不 setState。",
  },
  {
    id: "unbounded-cache",
    checklist: "计算-缓存边界",
    pattern: /\bnew\s+Map\s*\(|\bnew\s+Set\s*\(/,
    suggestion: "缓存/集合要有淘汰上限（本项目 LRU 保留 8 天），否则缓存本身又变成新的无界点。",
  },
  {
    id: "append-store",
    checklist: "识别",
    pattern: /\bappendFile\s*\(|flag\s*:\s*['"]a['"]/,
    suggestion: "新增了只增不减的数据点。落地前先登记进 references/registry.md，并按 5 步清单设计读/算/画/测试。",
  },
  {
    id: "setstate",
    checklist: "展示",
    pattern: /\bsetState\s*\(/,
    suggestion: "确认是否在轮询/高频回调里整页 setState；应数据没变就不重画（参考 TracePage 的 JSON 比较）。",
  },
];

function scanText(text, file, hits) {
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        hits.push({
          file,
          line: idx + 1,
          rule: rule.id,
          checklist: rule.checklist,
          text: line.trim().slice(0, 120),
          suggestion: rule.suggestion,
        });
      }
    }
  });
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT.has(extname(name))) {
      out.push(full);
    }
  }
}

function collectFiles(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      console.error("警告：路径不存在或不可读，跳过：" + p);
      continue;
    }
    if (st.isFile()) {
      if (EXT.has(extname(p))) out.push(p);
    } else if (st.isDirectory()) {
      walk(p, out);
    }
  }
  return out;
}

function render(hits, fileCount) {
  console.log("扫描 " + fileCount + " 个文件，发现 " + hits.length + " 处可疑点（均需人工判断）");
  console.log("");
  if (hits.length === 0) {
    console.log("没有发现可疑点。");
    return;
  }
  const byRule = {};
  for (const h of hits) {
    console.log(h.file + ":" + h.line + "  [" + h.rule + "] " + h.checklist);
    console.log("    " + h.text);
    console.log("    -> " + h.suggestion);
    console.log("");
    byRule[h.rule] = (byRule[h.rule] || 0) + 1;
  }
  console.log("汇总：");
  for (const k of Object.keys(byRule).sort()) {
    console.log("  " + k + ": " + byRule[k]);
  }
}

const HELP = [
  "用法: node scripts/scan-boundary.mjs [path...] [--json] [--selftest]",
  "",
  "  path        要扫描的文件或目录（可多个）；默认 src/ apps/",
  "  --json      输出机器可读 JSON",
  "  --selftest  运行内置自检后退出",
  "",
  "示例:",
  "  node scripts/scan-boundary.mjs",
  "  node scripts/scan-boundary.mjs src/tracing",
  "  node scripts/scan-boundary.mjs src/tracing/store.ts --json",
].join("\n");

function selftest() {
  const samples = [
    ["full-read-sync", 'const d = readFileSync("x.jsonl");'],
    ["full-read", 'const d = readFile("x.jsonl");'],
    ["full-parse", "rows.map((r) => JSON.parse(r));"],
    ["poll", "setInterval(tick, 1000);"],
    ["unbounded-cache", "const cache = new Map();"],
    ["append-store", 'appendFile("usage.jsonl", line);'],
    ["append-store", 'writeFile(f, d, { flag: "a" });'],
    ["setstate", "setState(next);"],
  ];
  let ok = true;
  for (const [rid, code] of samples) {
    const hits = [];
    scanText(code, "self", hits);
    if (!hits.some((h) => h.rule === rid)) {
      console.log("自检失败：规则 " + rid + " 未命中样例：" + code);
      ok = false;
    }
  }
  const clean = [];
  scanText("const x = 1 + 2;", "self", clean);
  if (clean.length !== 0) {
    console.log("自检失败：干净代码不应产生命中");
    ok = false;
  }
  if (ok) {
    console.log("自检通过");
    return 0;
  }
  return 1;
}

function main(argv) {
  let json = false;
  const paths = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--selftest") return selftest();
    else if (a === "--help" || a === "-h") {
      console.log(HELP);
      return 0;
    } else paths.push(a);
  }
  if (paths.length === 0) paths.push("src", "apps");

  const files = collectFiles(paths);
  const hits = [];
  const cwd = process.cwd();
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    scanText(text, relative(cwd, f), hits);
  }

  if (json) {
    console.log(JSON.stringify({ files_scanned: files.length, hit_count: hits.length, hits }, null, 2));
  } else {
    render(hits, files.length);
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
