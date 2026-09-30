import { describe, expect, it } from "vitest";
import { reflect } from "../src/self-optimize/reflection";
import type { ReflectInput } from "../src/self-optimize/reflection";
import { runSelfOptimizeCycle } from "../src/self-optimize/loop";
import type {
  BrokerResult,
  CacheVerdict,
  PolicyUpdate,
  ReuseDecision,
  SelfOptimizeCycleInput,
  TaskFingerprint,
} from "../src/domain";

function verdict(kind: CacheVerdict["kind"], hit: boolean): CacheVerdict {
  return { kind, hit, reason: hit ? "hit" : "ttl-expired", fingerprintMatch: hit };
}

function reuseDecision(verdicts: CacheVerdict[]): ReuseDecision {
  return {
    reuseMode: verdicts.length > 0 && verdicts.every((entry) => entry.hit) ? "REUSE" : "FRESH",
    confidence: 0.9,
    verdicts,
    rationale: [],
  };
}

function brokerResult(status: BrokerResult["status"], rounds = 2): BrokerResult {
  return { status, rounds, totalDurationMs: 1000, observations: [] };
}

interface ReflectOverrides {
  taskCategory?: string;
  decision?: ReuseDecision;
  result?: BrokerResult;
  totalDurationMs?: number;
  budgetMs?: number;
}

function reflectInput(overrides: ReflectOverrides = {}): ReflectInput {
  return {
    taskCategory: overrides.taskCategory ?? "bugfix",
    decision: overrides.decision ?? reuseDecision([verdict("context", true)]),
    totalDurationMs: overrides.totalDurationMs ?? 1000,
    budgetMs: overrides.budgetMs ?? 2000,
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
  };
}

const fingerprint: TaskFingerprint = {
  semanticTaskHash: "semantic",
  projectStateHash: "project",
  contextStateHash: "context",
  environmentStateHash: "environment",
  reuseKey: "semantic|project|context|environment",
};

const policy: PolicyUpdate = {
  version: 1,
  minSamples: 5,
  modelTierByCategory: { bugfix: "standard" },
  executionModeByCategory: { bugfix: "one-shot" },
  avoidPatterns: [],
  rationale: [],
};

interface CycleOverrides {
  taskCategory?: string;
  reuse?: ReuseDecision;
  result?: BrokerResult;
  totalDurationMs?: number;
  budgetMs?: number;
}

function cycleInput(overrides: CycleOverrides = {}): SelfOptimizeCycleInput {
  return {
    task: "fix axis homing",
    taskCategory: overrides.taskCategory ?? "bugfix",
    fingerprint,
    reuse: overrides.reuse ?? reuseDecision([verdict("context", true)]),
    policy,
    totalDurationMs: overrides.totalDurationMs ?? 1000,
    budgetMs: overrides.budgetMs ?? 2000,
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
  };
}

describe("reflection rules (plan §21)", () => {
  it("(a) cache-win: any hit with no result lists the hit layers", () => {
    const findings = reflect(
      reflectInput({ decision: reuseDecision([verdict("context", true), verdict("plan", false)]) })
    );
    expect(findings).toEqual([{ kind: "cache-win", detail: "cache-hit-layers=context" }]);
  });

  it("(a) cache-win: any hit with a completed result still wins", () => {
    const findings = reflect(reflectInput({ result: brokerResult("completed") }));
    expect(findings.map((finding) => finding.kind)).toContain("cache-win");
  });

  it("(a) negative: a hit followed by a non-completed result is not a cache-win", () => {
    for (const status of ["failed", "budget-exhausted", "stopped"] as const) {
      const findings = reflect(reflectInput({ result: brokerResult(status) }));
      expect(findings.map((finding) => finding.kind)).not.toContain("cache-win");
    }
  });

  it("(a) negative: all-miss verdicts never produce a cache-win", () => {
    const findings = reflect(reflectInput({ decision: reuseDecision([verdict("context", false)]) }));
    expect(findings.map((finding) => finding.kind)).not.toContain("cache-win");
  });

  it("(b) cache-miss: repetition category with all-miss verdicts lists the missed kinds", () => {
    const findings = reflect(
      reflectInput({
        taskCategory: "repetition",
        decision: reuseDecision([verdict("context", false), verdict("plan", false)]),
      })
    );
    expect(findings).toContainEqual({ kind: "cache-miss", detail: "missed-kinds=context,plan" });
  });

  it("(b) negative: all-miss verdicts outside the repetition category produce no cache-miss", () => {
    const findings = reflect(reflectInput({ decision: reuseDecision([verdict("context", false)]) }));
    expect(findings.map((finding) => finding.kind)).not.toContain("cache-miss");
  });

  it("(b) negative: repetition category with a hit produces no cache-miss", () => {
    const findings = reflect(
      reflectInput({
        taskCategory: "repetition",
        decision: reuseDecision([verdict("context", true), verdict("plan", false)]),
      })
    );
    expect(findings.map((finding) => finding.kind)).not.toContain("cache-miss");
  });

  it("(c) over-budget fires only when duration strictly exceeds the budget", () => {
    const over = reflect(reflectInput({ totalDurationMs: 12000, budgetMs: 10000 }));
    expect(over).toContainEqual({
      kind: "over-budget",
      detail: "duration-ms=12000;budget-ms=10000",
    });
    const atLimit = reflect(reflectInput({ totalDurationMs: 10000, budgetMs: 10000 }));
    expect(atLimit.map((finding) => finding.kind)).not.toContain("over-budget");
    const under = reflect(reflectInput({ totalDurationMs: 9999, budgetMs: 10000 }));
    expect(under.map((finding) => finding.kind)).not.toContain("over-budget");
  });

  it("(d) quality-floor-miss fires only for a failed result", () => {
    const failed = reflect(reflectInput({ result: brokerResult("failed", 3) }));
    expect(failed).toContainEqual({ kind: "quality-floor-miss", detail: "rounds=3" });
    for (const status of ["completed", "budget-exhausted", "stopped"] as const) {
      const findings = reflect(reflectInput({ result: brokerResult(status) }));
      expect(findings.map((finding) => finding.kind)).not.toContain("quality-floor-miss");
    }
    const noResult = reflect(reflectInput());
    expect(noResult.map((finding) => finding.kind)).not.toContain("quality-floor-miss");
  });

  it("(e) no verdicts at all: cache-miss with the no-cache-layer prefix", () => {
    const findings = reflect(reflectInput({ decision: reuseDecision([]) }));
    expect(findings).toContainEqual({ kind: "cache-miss", detail: "no-cache-layer" });
  });

  it("(e) negative: decisions with verdicts never report the no-cache-layer miss", () => {
    const findings = reflect(reflectInput({ decision: reuseDecision([verdict("result", false)]) }));
    expect(findings.map((finding) => finding.kind)).not.toContain("cache-miss");
  });

  it("independent rules stack; every detail is one machine-parsable line", () => {
    const findings = reflect(
      reflectInput({
        taskCategory: "repetition",
        decision: reuseDecision([verdict("context", false)]),
        result: brokerResult("failed", 4),
        totalDurationMs: 5000,
        budgetMs: 1000,
      })
    );
    expect(findings.map((finding) => finding.kind)).toEqual([
      "cache-miss",
      "over-budget",
      "quality-floor-miss",
    ]);
    for (const finding of findings) {
      expect(finding.detail).toMatch(/^[a-z][a-z0-9-]*(=|$)/);
      expect(finding.detail).not.toContain("\n");
    }
  });
});

describe("self-optimize cycle composition (plan §21)", () => {
  it("default deps: reflections fire, policyUpdates empty, decision passes through", () => {
    const input = cycleInput({ totalDurationMs: 5000, budgetMs: 1000 });
    const outcome = runSelfOptimizeCycle(input);
    expect(outcome.decision).toBe(input.reuse);
    expect(outcome.reflections.map((finding) => finding.kind)).toContain("over-budget");
    expect(outcome.policyUpdates).toEqual([]);
  });

  it("the learner is called exactly once with the derived summary", () => {
    const calls: Array<{ category: string; success: boolean; rounds: number; samples: number }> = [];
    runSelfOptimizeCycle(cycleInput({ result: brokerResult("completed", 3) }), {
      policyLearnerFn: (summary) => {
        calls.push(summary);
        return undefined;
      },
    });
    expect(calls).toEqual([{ category: "bugfix", success: true, rounds: 3, samples: 1 }]);
  });

  it("without a result the learner sees success=false and rounds=0", () => {
    const calls: Array<{ category: string; success: boolean; rounds: number; samples: number }> = [];
    runSelfOptimizeCycle(cycleInput(), {
      policyLearnerFn: (summary) => {
        calls.push(summary);
        return undefined;
      },
    });
    expect(calls).toEqual([{ category: "bugfix", success: false, rounds: 0, samples: 1 }]);
  });

  it("a PolicyUpdate returned by the learner rides in policyUpdates verbatim", () => {
    const update: PolicyUpdate = {
      version: 7,
      minSamples: 3,
      modelTierByCategory: { bugfix: "heavy" },
      executionModeByCategory: { bugfix: "loop" },
      avoidPatterns: ["grep-everything"],
      rationale: ["escalated bugfix to heavy tier"],
    };
    const outcome = runSelfOptimizeCycle(cycleInput(), { policyLearnerFn: () => update });
    expect(outcome.policyUpdates).toEqual([update]);
    expect(outcome.policyUpdates[0]).toBe(update);
  });

  it("an injected reflectFn replaces the built-in rules", () => {
    const outcome = runSelfOptimizeCycle(cycleInput(), {
      reflectFn: (input) => [
        { kind: "model-tier-escalation", detail: `stub:${input.taskCategory}` },
      ],
    });
    expect(outcome.reflections).toEqual([
      { kind: "model-tier-escalation", detail: "stub:bugfix" },
    ]);
  });

  it("deterministic: identical input yields deep-equal outcomes", () => {
    const input = cycleInput({
      taskCategory: "repetition",
      reuse: reuseDecision([verdict("context", false)]),
      result: brokerResult("failed", 2),
      totalDurationMs: 9000,
      budgetMs: 1000,
    });
    expect(runSelfOptimizeCycle(input)).toEqual(runSelfOptimizeCycle(input));
  });
});
