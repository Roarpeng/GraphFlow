/**
 * P4 Trajectory learning (2.x plan §18): the per-task execution record that
 * feeds the policy learner. A trajectory is what actually happened — which
 * reuse mode and model tier the efficiency layer picked, how many rounds and
 * calls it took, whether validation and the task itself succeeded — plus, when
 * it failed, the stage where it failed.
 *
 * P4 轨迹学习：每个任务一条执行轨迹记录，是策略学习器的唯一输入。
 * 纯结构校验 + 纯统计聚合，无模型训练（NO model training — stats only）。
 *
 * Invariants:
 *  - `validateTrajectory` reports STRUCTURAL violations only (missing ids,
 *    negative counts, rounds < 1, bad enum shapes). A record with violations
 *    is skipped by the summarizer, never fatal to the batch.
 *  - `summarizeTrajectories` is deterministic: categories sorted by name,
 *    failure stages sorted by count desc then stage name asc.
 */

export interface TrajectoryRecord {
  taskId: string;
  taskCategory: string;
  startedAt: string;
  finishedAt?: string;
  decision: {
    reuseMode: "REUSE" | "ADAPT" | "FRESH";
    modelTier: "economy" | "standard" | "heavy";
  };
  rounds: number;
  llmCalls: number;
  toolCalls: number;
  cacheHits: number;
  cacheMisses: number;
  validationPassed: boolean;
  success: boolean;
  costMs: number;
  costTokens: number;
  failureStage?: string;
}

/** Per-category rollup the policy learner consumes. */
export interface CategoryStats {
  category: string;
  samples: number;
  successRate: number;
  avgRounds: number;
  avgCostMs: number;
  cacheHitRate: number;
  failureStages: Array<{ stage: string; count: number }>;
}

const REUSE_MODES: readonly string[] = ["REUSE", "ADAPT", "FRESH"];
const MODEL_TIERS: readonly string[] = ["economy", "standard", "heavy"];

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const checkCount = (
  violations: string[],
  field: string,
  value: unknown,
  min: number
): void => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    violations.push(`${field}: finite number required`);
    return;
  }
  if (value < min) {
    violations.push(`${field}: must be >= ${min}`);
  }
};

/**
 * Structural validation. Returns violation strings; an empty array means the
 * record may enter `summarizeTrajectories`. Checks: non-empty taskId /
 * taskCategory / startedAt, decision enum shapes, rounds >= 1, and
 * non-negative counts and costs.
 */
export function validateTrajectory(record: TrajectoryRecord): string[] {
  const violations: string[] = [];
  // Runtime input is only as trustworthy as the JSON it came from; narrow
  // defensively even though the type says otherwise.
  const r = record as Partial<TrajectoryRecord>;

  if (!isNonEmptyString(r.taskId)) {
    violations.push("taskId: non-empty string required");
  }
  if (!isNonEmptyString(r.taskCategory)) {
    violations.push("taskCategory: non-empty string required");
  }
  if (!isNonEmptyString(r.startedAt)) {
    violations.push("startedAt: non-empty string required");
  }

  const decision = r.decision as
    | Partial<NonNullable<TrajectoryRecord["decision"]>>
    | undefined;
  if (decision === undefined) {
    violations.push("decision: reuseMode/modelTier required");
  } else {
    if (!REUSE_MODES.includes(decision.reuseMode as string)) {
      violations.push("decision.reuseMode: REUSE|ADAPT|FRESH required");
    }
    if (!MODEL_TIERS.includes(decision.modelTier as string)) {
      violations.push("decision.modelTier: economy|standard|heavy required");
    }
  }

  checkCount(violations, "rounds", r.rounds, 1);
  checkCount(violations, "llmCalls", r.llmCalls, 0);
  checkCount(violations, "toolCalls", r.toolCalls, 0);
  checkCount(violations, "cacheHits", r.cacheHits, 0);
  checkCount(violations, "cacheMisses", r.cacheMisses, 0);
  checkCount(violations, "costMs", r.costMs, 0);
  checkCount(violations, "costTokens", r.costTokens, 0);

  if (typeof r.validationPassed !== "boolean") {
    violations.push("validationPassed: boolean required");
  }
  if (typeof r.success !== "boolean") {
    violations.push("success: boolean required");
  }

  return violations;
}

/**
 * Aggregate valid records into per-category stats. Invalid records are
 * skipped (not fatal). Rates and averages are plain divisions of the valid
 * sample; cacheHitRate is 0 when the category recorded no cache traffic.
 * Output is sorted by category name; failureStages by count desc then name.
 */
export function summarizeTrajectories(
  records: readonly TrajectoryRecord[]
): CategoryStats[] {
  const groups = new Map<string, TrajectoryRecord[]>();
  for (const record of records) {
    if (validateTrajectory(record).length > 0) {
      continue;
    }
    const bucket = groups.get(record.taskCategory);
    if (bucket === undefined) {
      groups.set(record.taskCategory, [record]);
    } else {
      bucket.push(record);
    }
  }

  const stats: CategoryStats[] = [];
  for (const [category, group] of groups) {
    const samples = group.length;
    const successes = group.reduce((acc, r) => acc + (r.success ? 1 : 0), 0);
    const totalRounds = group.reduce((acc, r) => acc + r.rounds, 0);
    const totalCostMs = group.reduce((acc, r) => acc + r.costMs, 0);
    const hits = group.reduce((acc, r) => acc + r.cacheHits, 0);
    const misses = group.reduce((acc, r) => acc + r.cacheMisses, 0);

    const stageCounts = new Map<string, number>();
    for (const r of group) {
      if (isNonEmptyString(r.failureStage)) {
        stageCounts.set(
          r.failureStage,
          (stageCounts.get(r.failureStage) ?? 0) + 1
        );
      }
    }
    const failureStages = [...stageCounts.entries()]
      .map(([stage, count]) => ({ stage, count }))
      .sort(
        (a, b) =>
          b.count - a.count || (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0)
      );

    stats.push({
      category,
      samples,
      successRate: successes / samples,
      avgRounds: totalRounds / samples,
      avgCostMs: totalCostMs / samples,
      cacheHitRate: hits + misses > 0 ? hits / (hits + misses) : 0,
      failureStages,
    });
  }

  return stats.sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : 0
  );
}
