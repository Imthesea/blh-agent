import type { Arm } from "./lift.js";

export interface AblationTask {
  caseId: string;
  arm: Arm;
  runNumber: number;
}

/**
 * 把 case × run 展开成任务列表。
 * 每次重复里 variant 顺序按 runNumber 交替（奇数次 control→treatment，偶数次反序），消除顺序偏差。
 */
export function createAblationPlan(caseIds: readonly string[], runsPerVariant: number): AblationTask[] {
  if (!Number.isInteger(runsPerVariant) || runsPerVariant < 1) {
    throw new Error("runsPerVariant must be a positive integer");
  }
  const tasks: AblationTask[] = [];
  for (const caseId of caseIds) {
    for (let runNumber = 1; runNumber <= runsPerVariant; runNumber += 1) {
      const order: Arm[] = runNumber % 2 === 1 ? ["control", "treatment"] : ["treatment", "control"];
      for (const arm of order) tasks.push({ caseId, arm, runNumber });
    }
  }
  return tasks;
}