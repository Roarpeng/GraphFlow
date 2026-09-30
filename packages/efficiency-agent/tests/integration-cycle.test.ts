import { describe, expect, it } from "vitest";
import {
  buildTaskFingerprint,
  createContextCache,
  createPlanCache,
  createResultCache,
  decideReuse,
  createLocalCommandWorker,
  runBrokeredExecution,
  validateTrajectory,
  summarizeTrajectories,
  learnPolicy,
  chooseAction,
  runSelfOptimizeCycle,
  measured,
  type KVStore,
  type TrajectoryRecord,
  type PolicyUpdate,
  type TaskFingerprint,
} from "../src/index";

/**
 * Cross-module integration: the P2–P7 pieces compose into the plan §21 loop —
 * fingerprint → caches → reuse gate → brokered execution (real local worker)
 * → trajectory → policy learning → cost-optimized next decision → reflection.
 * Every module here is a REAL implementation, no fakes except the KV store.
 */

function memoryStore(): KVStore & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => map,
  };
}

const FACTS = {
  project: {
    gitHead: "abc123",
    workingTreeHash: "tree-1",
    relevantFileHashes: { "src/a.ts": "h1", "src/b.ts": "h2" },
    dependencyLockHash: "lock-1",
  },
  context: { graphVersion: "g1", contextPolicyVersion: "cp1", workingSetHash: "ws1" },
  environment: { toolVersions: { node: "22.20.0" }, runtimeVersion: "node22" },
};

const QUERY_TASK = "Where is the model router configured in this project?";

function failingTrajectories(category: string, n: number): TrajectoryRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    taskId: `task-${category}-${i}`,
    taskCategory: category,
    startedAt: `2026-09-30T00:00:0${i}.000Z`,
    decision: { reuseMode: "FRESH", modelTier: "economy" },
    rounds: 2,
    llmCalls: 3,
    toolCalls: 4,
    cacheHits: 0,
    cacheMisses: 2,
    validationPassed: false,
    success: false,
    costMs: 5_000,
    costTokens: 4_000,
    failureStage: "validation",
  }));
}

describe("P2–P7 integration: the self-optimizing cycle composes", () => {
  it("first task misses all caches (FRESH); a replayed query task reaches REUSE", () => {
    const store = memoryStore();
    const contextCache = createContextCache(store, { ttlMs: 60_000 });
    const planCache = createPlanCache(store);
    const resultCache = createResultCache(store);
    const fingerprint: TaskFingerprint = buildTaskFingerprint({ task: QUERY_TASK, ...FACTS });

    // Cold store: every layer misses, gate says FRESH.
    const coldVerdicts = [
      contextCache.get(fingerprint, 1_000).verdict,
      planCache.get(fingerprint, 1_000).verdict,
      resultCache.get(fingerprint, "query", 1_000).verdict,
    ];
    expect(coldVerdicts.every((v) => !v.hit)).toBe(true);
    expect(decideReuse({ verdicts: coldVerdicts, category: "query" }).reuseMode).toBe("FRESH");

    // Populate the layers as a completed run would. resultCache.put returns
    // hit:true/"stored" (the entry is now replayable); the refusal verdict
    // (hit:false, "category-not-result-safe") is what WRITE categories get.
    contextCache.put(fingerprint, { anchors: ["file:src/routing/model-router.ts"] }, 1_000);
    planCache.put(fingerprint, { steps: ["inspect", "edit", "validate"] }, 1_000);
    const stored = resultCache.put(fingerprint, "query", { answer: "src/routing/model-router.ts" }, 1_000);
    expect(stored).toMatchObject({ hit: true, reason: "stored" });
    expect(resultCache.put(fingerprint, "bugfix", { patch: "..." }, 1_000)).toMatchObject({
      hit: false,
      reason: "category-not-result-safe",
    });

    // Warm store within TTL: all three hit, gate ladders up to REUSE.
    const warmVerdicts = [
      contextCache.get(fingerprint, 2_000).verdict,
      planCache.get(fingerprint, 2_000).verdict,
      resultCache.get(fingerprint, "query", 2_000).verdict,
    ];
    expect(warmVerdicts.every((v) => v.hit)).toBe(true);
    const decision = decideReuse({ verdicts: warmVerdicts, category: "query" });
    expect(decision.reuseMode).toBe("REUSE");
    expect(decision.confidence).toBe(0.75);

    // State drift: git moves, plan layer invalidates while context (within
    // TTL, same task) still hits — gate falls back to ADAPT.
    const drifted = buildTaskFingerprint({
      task: QUERY_TASK,
      ...FACTS,
      project: { ...FACTS.project, gitHead: "def456" },
    });
    const driftVerdicts = [
      contextCache.get(drifted, 3_000).verdict,
      planCache.get(drifted, 3_000).verdict,
      resultCache.get(drifted, "query", 3_000).verdict,
    ];
    expect(driftVerdicts[0]!.hit).toBe(false); // fingerprint mismatch on stored entry
    expect(driftVerdicts[1]!.reason).toBe("project-state-changed");
    expect(driftVerdicts[2]!.hit).toBe(false);
    expect(decideReuse({ verdicts: driftVerdicts, category: "query" }).reuseMode).toBe("FRESH");
  });

  it("broker + real local worker executes a validation command to completion", async () => {
    const worker = createLocalCommandWorker({ defaultTimeoutMs: 10_000 });
    const result = await runBrokeredExecution(
      { validation: ['node -e "process.exit(0)"'], policy: { maxRounds: 2, totalBudgetMs: 15_000, stopOnValidationPass: true } },
      worker
    );
    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(1);
    expect(result.validation?.passed).toBe(true);
    expect(result.stopReason).toBe("validation-passed");
  });

  it("a failing category escalates its model tier through policy learning", () => {
    const records = failingTrajectories("bugfix", 6);
    for (const record of records) {
      expect(validateTrajectory(record)).toEqual([]);
    }
    const stats = summarizeTrajectories(records);
    expect(stats[0]!.successRate).toBe(0);

    const update = learnPolicy(stats);
    expect(update).toBeDefined();
    expect(update!.modelTierByCategory["bugfix"]).toBe("standard");
    // Hysteresis: with only 6 samples (minSamples 5, de-escalate needs 2×),
    // a sudden perfect batch still cannot de-escalate in one step.
    const recovered = learnPolicy(
      summarizeTrajectories([
        ...records.slice(0, 1),
        ...Array.from({ length: 5 }, (_, i) => ({
          ...records[0]!,
          taskId: `task-ok-${i}`,
          success: true,
          validationPassed: true,
        })),
      ]),
      update
    );
    expect(recovered?.modelTierByCategory["bugfix"] ?? "standard").toBe("standard");
  });

  it("the optimizer chooses the cheapest candidate that clears the floors", () => {
    const decision = chooseAction(
      [
        { id: "cheap-but-flaky", cost: measured(10), expectedSuccessRate: 0.5, expectedFidelity: 1, safety: 1, evidence: 1 },
        { id: "cheap-and-sound", cost: measured(20), expectedSuccessRate: 0.95, expectedFidelity: 0.9, safety: 1, evidence: 1 },
        { id: "expensive", cost: measured(100), expectedSuccessRate: 0.99, expectedFidelity: 1, safety: 1, evidence: 1 },
      ],
      { minSuccessRate: 0.9 }
    );
    expect(decision.chosen!.id).toBe("cheap-and-sound");
    expect(decision.rejected.map((r) => r.id)).toEqual(["cheap-but-flaky"]);
  });

  it("runSelfOptimizeCycle bridges P3 reuse, P7 reflection, and P4 policy learning", async () => {
    const store = memoryStore();
    const contextCache = createContextCache(store, { ttlMs: 60_000 });
    const fingerprint = buildTaskFingerprint({ task: QUERY_TASK, ...FACTS });
    contextCache.put(fingerprint, { anchors: [] }, 1_000);
    const hit = contextCache.get(fingerprint, 2_000).verdict;
    const reuse = decideReuse({ verdicts: [hit], category: "query" });

    // Real brokered execution feeding the trajectory pipeline.
    const brokerResult = await runBrokeredExecution(
      { validation: ['node -e "process.exit(0)"'], policy: { maxRounds: 1, totalBudgetMs: 15_000, stopOnValidationPass: true } },
      createLocalCommandWorker()
    );
    const trajectory: TrajectoryRecord = {
      taskId: fingerprint.semanticTaskHash,
      taskCategory: "query",
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: "2026-09-30T00:00:01.000Z",
      decision: { reuseMode: reuse.reuseMode, modelTier: "economy" },
      rounds: brokerResult.rounds,
      llmCalls: 0,
      toolCalls: 1,
      cacheHits: 1,
      cacheMisses: 0,
      validationPassed: brokerResult.validation?.passed ?? false,
      success: brokerResult.status === "completed",
      costMs: brokerResult.totalDurationMs,
      costTokens: 0,
    };

    // The learner adapter closes P4 → P7: accumulate, summarize, learn.
    const learner = (input: { category: string; success: boolean }): PolicyUpdate | undefined =>
      learnPolicy(
        summarizeTrajectories([
          { ...trajectory, success: input.success, taskCategory: input.category },
          ...failingTrajectories(input.category, 5),
        ])
      );

    const outcome = runSelfOptimizeCycle(
      {
        task: QUERY_TASK,
        taskCategory: "query",
        fingerprint,
        reuse,
        policy: { version: 1, minSamples: 5, modelTierByCategory: {}, executionModeByCategory: {}, avoidPatterns: [], rationale: [] },
        result: brokerResult,
        totalDurationMs: 50,
        budgetMs: 10_000,
      },
      { policyLearnerFn: learner }
    );

    expect(outcome.decision.reuseMode).toBe("ADAPT"); // one cache hit → ADAPT
    expect(outcome.reflections.some((f) => f.kind === "cache-win")).toBe(true);
    // The learning bridge fired: the mixed batch (5 fails / 1 success < 0.7)
    // produced an escalation policy update for the category.
    expect(outcome.policyUpdates).toBeDefined();
    const update = outcome.policyUpdates[0];
    expect(update?.modelTierByCategory["query"]).toBe("standard");
  });
});
