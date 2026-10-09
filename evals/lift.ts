/** A/B 对比的两臂：control（去掉某特性）vs treatment（保留/加上某特性）。 */
export type Arm = "control" | "treatment";

export type CaseOutcomeKind = "passed" | "failed" | "errored" | "skipped";

export interface CaseOutcome {
  caseId: string;
  arm: Arm;
  runNumber: number;
  outcome: CaseOutcomeKind;
}

export type LiftFlag =
  | "no-lift"
  | "negative-delta"
  | "control-saturated"
  | "treatment-saturated"
  | "flaky";

export interface LiftResult {
  eligiblePairs: number;
  blockedPairs: number;
  controlPassRate: number | null;
  treatmentPassRate: number | null;
  lift: number | null;
  flags: LiftFlag[];
}

/** 该结果是否「有分」：仅 passed/failed 计入通过率，errored/skipped/缺失不算。 */
function isScored(outcome: CaseOutcome | undefined): boolean {
  return outcome !== undefined && (outcome.outcome === "passed" || outcome.outcome === "failed");
}

/**
 * 从一组跑分结果算 A/B lift 与 flags。
 * 规则（对齐 pi）：
 *  - 只有 control + treatment 两臂都「有分」（passed/failed）的 pair 才计入 pass rate；
 *  - 任一臂 errored/skipped/缺失则该 pair blocked；有 blocked 时 headline（通过率/lift）整体 withhold（置 null）；
 *  - flags 用整数比较，避免浮点误差。
 */
export function computeLift(outcomes: readonly CaseOutcome[]): LiftResult {
  // 用 (caseId, runNumber) 做唯一键，把同一题、同一轮的 control 和 treatment 两条结果配对。
  // \u0000 是空字符，用来当分隔符，避免 caseId 里碰巧出现分隔符导致串键。
  const pairKey = (caseId: string, runNumber: number): string => `${caseId}\u0000${runNumber}`;
  const pairs = new Map<string, { control: CaseOutcome | undefined; treatment: CaseOutcome | undefined }>();

  // 第一步：把所有跑分结果按「题 + 轮次」归组，凑成一对一对的 { control, treatment }。
  for (const outcome of outcomes) {
    const key = pairKey(outcome.caseId, outcome.runNumber);
    // 还没这组就先建一个空对，两臂都是 undefined
    const pair = pairs.get(key) ?? { control: undefined, treatment: undefined };
    // 根据这条结果属于哪一臂，填进对应的位置
    if (outcome.arm === "control") pair.control = outcome;
    else pair.treatment = outcome;
    pairs.set(key, pair);
  }

  // 四个计数器：有效对、被跳过对、control 通过数、treatment 通过数
  let eligiblePairs = 0;
  let blockedPairs = 0;
  let controlPassed = 0;
  let treatmentPassed = 0;

  // 第二步：逐对判断。只有两臂都「有分」（passed/failed）才算有效，否则这对没法比，计入 blocked。
  for (const pair of pairs.values()) {
    if (isScored(pair.control) && isScored(pair.treatment)) {
      eligiblePairs += 1;
      // 分别统计两臂里 passed 的次数
      if (pair.control?.outcome === "passed") controlPassed += 1;
      if (pair.treatment?.outcome === "passed") treatmentPassed += 1;
    } else {
      blockedPairs += 1;
    }
  }

  // 第三步：只要有一对被跳过、或者一个有效对都没有，就把结论整体 withhold（置 null）。
  // 因为数据不完整时算出来的通过率/lift 是失真的，宁可不给结论也不误导。
  const withheld = blockedPairs > 0 || eligiblePairs === 0;
  // 两臂通过率 = 各自 passed 数 / 有效对数
  const controlPassRate = withheld ? null : controlPassed / eligiblePairs;
  const treatmentPassRate = withheld ? null : treatmentPassed / eligiblePairs;
  // lift = treatment 通过率 - control 通过率；用整数相减再除，避免浮点误差
  const lift = withheld ? null : (treatmentPassed - controlPassed) / eligiblePairs;

  // 第四步：给结论打警示标志（flags）。数据不完整时跳过，因为结论本身都不公布了。
  const flags: LiftFlag[] = [];
  if (!withheld) {
    // 对照组全过 → 这题太简单，已经满分，没有提升空间
    if (controlPassed === eligiblePairs) flags.push("control-saturated");
    // 实验组全过 → 可能到天花板了
    if (treatmentPassed === eligiblePairs) flags.push("treatment-saturated");
    // 两臂通过数一样 → 特性没带来任何变化
    if (treatmentPassed === controlPassed) flags.push("no-lift");
    // 实验组反而更差 → 特性有负作用
    if (treatmentPassed < controlPassed) flags.push("negative-delta");
  }

  // 第五步：单独判断「不稳定」。同一题、同一臂，在不同轮里结果一会儿过一会儿挂，说明随机性大、结论不可信。
  const flakyKey = (caseId: string, arm: Arm): string => `${caseId}\u0000${arm}`;
  const flaky = new Map<string, Set<string>>();
  for (const outcome of outcomes) {
    // 只有 passed/failed 才参与稳定性判断，报错/跳过不算
    if (outcome.outcome !== "passed" && outcome.outcome !== "failed") continue;
    const key = flakyKey(outcome.caseId, outcome.arm);
    // 用 Set 收集同一 (题, 臂) 出现过的所有结果种类
    const set = flaky.get(key) ?? new Set<string>();
    set.add(outcome.outcome);
    flaky.set(key, set);
  }
  // 只要有一组同时出现过 passed 和 failed（Set 里不止一种），就标记为不稳定
  if ([...flaky.values()].some((set) => set.size > 1)) flags.push("flaky");

  return { eligiblePairs, blockedPairs, controlPassRate, treatmentPassRate, lift, flags };
}