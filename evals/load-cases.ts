import { readFileSync } from "node:fs";
import type { EvalCase } from "./check.js";

/** 读 JSONL 题库文件，返回用例列表。 */
export function loadCases(file: string): EvalCase[] {
  const text = readFileSync(file, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as EvalCase);
}