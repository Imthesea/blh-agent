import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceRoot = path.join(repoRoot, "src");
const defaultConfig = path.join(repoRoot, "architecture.config.json");

function parseArgs(argv) {
  const parsed = { root: defaultSourceRoot, config: defaultConfig };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") parsed.root = path.resolve(argv[index + 1] ?? ".");
    else if (argv[index] === "--config") parsed.config = path.resolve(argv[index + 1] ?? ".");
  }
  return parsed;
}

function walkTypeScriptFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) files.push(...walkTypeScriptFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

function sourceImports(file) {
  const text = readFileSync(file, "utf8");
  const imports = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?from\s+)?["'](\.[^"']+)["']/g;
  let match = pattern.exec(text);
  while (match !== null) {
    imports.push(match[1]);
    match = pattern.exec(text);
  }
  return imports;
}

function destinationDirectory(sourceRoot, sourceFile, specifier) {
  const target = path.resolve(path.dirname(sourceFile), specifier);
  const relative = path.relative(sourceRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] ?? null;
}

function edgeKey(from, to) {
  return `${from}->${to}`;
}

export function collectViolations(sourceRoot, config) {
  const features = new Set(config.featureDirectories);
  const shared = new Set(config.sharedDirectories);
  const allowedEdges = new Set(
    config.allowedFeatureEdges
      .filter((edge) => Array.isArray(edge))
      .map(([from, to]) => edgeKey(from, to)),
  );
  const violations = [];

  for (const file of walkTypeScriptFiles(sourceRoot)) {
    const from = path.relative(sourceRoot, file).split(path.sep)[0];
    if (from === undefined) continue;

    for (const specifier of sourceImports(file)) {
      const to = destinationDirectory(sourceRoot, file, specifier);
      if (to === null || to === from) continue;

      if (from === "contracts" && to !== "contracts") {
        violations.push(`${path.relative(sourceRoot, file)}: contracts cannot import ${to}`);
        continue;
      }

      if (from === "runtime" && !shared.has(to) && (features.has(to) || to === config.compositionRoot)) {
        violations.push(`${path.relative(sourceRoot, file)}: runtime cannot import ${to}`);
        continue;
      }

      if (features.has(from) && to === config.compositionRoot) {
        violations.push(`${path.relative(sourceRoot, file)}: features cannot import cli`);
        continue;
      }

      if (
        features.has(from) &&
        features.has(to) &&
        !shared.has(to) &&
        !allowedEdges.has(edgeKey(from, to))
      ) {
        violations.push(`${path.relative(sourceRoot, file)}: ${from} cannot import ${to}`);
      }
    }
  }
  return violations;
}

function main() {
  const { root, config: configPath } = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const violations = collectViolations(root, config);
  if (violations.length > 0) {
    console.error("Architecture violations:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
