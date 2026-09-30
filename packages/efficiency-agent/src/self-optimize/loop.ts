import type {
  CycleOutcome,
  PolicyUpdate,
  SelfOptimizeCycleInput,
} from "../domain.js";
import { reflect } from "./reflection.js";
import type { ReflectInput } from "./reflection.js";

/** Summary handed to the policy learner once per cycle. */
export interface PolicyLearnerInput {
  category: string;
  success: boolean;
  rounds: number;
  samples: number;
}

/**
 * Injectable dependencies for runSelfOptimizeCycle. 默认依赖即内置实现：
 * the built-in reflect rules and a no-op learner (returns undefined, meaning
 * "not enough evidence to change policy yet").
 */
export interface CycleDeps {
  reflectFn?: typeof reflect;
  policyLearnerFn?: (input: PolicyLearnerInput) => PolicyUpdate | undefined;
}

/** Default learner: never enough evidence on a single sample. */
function defaultPolicyLearner(_input: PolicyLearnerInput): PolicyUpdate | undefined {
  return undefined;
}

/**
 * One self-optimizing cycle (2.x plan §21): reflect over the finished task,
 * then ask the policy learner whether any policy should change.
 * 复盘一次已执行任务，并让策略学习者决定是否产出 PolicyUpdate。
 *
 * Composition:
 *  - reflections ← reflectFn({ taskCategory, decision: input.reuse, result,
 *    totalDurationMs, budgetMs });
 *  - policyUpdates ← policyLearnerFn called exactly once with
 *    { category, success: result "completed", rounds: result rounds ?? 0,
 *    samples: 1 }; an undefined answer yields an empty list, a PolicyUpdate
 *    rides through verbatim;
 *  - decision is the cycle's own ReuseDecision, passed through untouched.
 *
 * Pure: no clock, no randomness, no input mutation — the same input always
 * produces a deep-equal outcome.
 */
export function runSelfOptimizeCycle(
  input: SelfOptimizeCycleInput,
  deps?: CycleDeps
): CycleOutcome {
  const reflectFn = deps?.reflectFn ?? reflect;
  const policyLearnerFn = deps?.policyLearnerFn ?? defaultPolicyLearner;

  const reflectInput: ReflectInput = {
    taskCategory: input.taskCategory,
    decision: input.reuse,
    ...(input.result !== undefined ? { result: input.result } : {}),
    totalDurationMs: input.totalDurationMs,
    budgetMs: input.budgetMs,
  };
  const reflections = reflectFn(reflectInput);

  const policyUpdate = policyLearnerFn({
    category: input.taskCategory,
    success: input.result?.status === "completed",
    rounds: input.result?.rounds ?? 0,
    samples: 1,
  });

  return {
    decision: input.reuse,
    reflections,
    policyUpdates: policyUpdate === undefined ? [] : [policyUpdate],
  };
}
