import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildRealWorkerTrace,
  compareEffBench,
  loadCorpus,
  runEffBench,
} from "../benchmarks/eff-bench-lib";
import {
  validateTraceProvenance,
  type TaskTrace,
} from "../packages/efficiency-agent/src/index";

describe("Real Worker Benchmark & Measurement Contract (R1-R6)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "graphflow-real-worker-bench-test-"));
  const baselineOut = join(outDir, "baseline.jsonl");
  const shadowOut = join(outDir, "shadow.jsonl");

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  describe("TaskTrace Construction & Measured Semantics", () => {
    it("builds a TaskTrace where all cost fields carry strict measured provenance", () => {
      const trace = buildRealWorkerTrace({
        task: {
          text: "Implement safe worker execution",
          taskId: "task-001",
          category: "single-file",
        },
        worker: "typesafe-jev",
        mode: "baseline",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        totalDurationMs: 1450,
        success: true,
        rounds: 1,
        contextTokens: 250,
        llmCalls: 2,
        totalTokens: 600,
        inputTokens: 450,
        outputTokens: 150,
        validation: [
          { name: "type-safe", passed: true },
          { name: "exit-code", passed: true },
        ],
        advisory: {
          taskId: "task-001",
          reuseMode: "FRESH",
          durationMs: 45,
          llmCalls: 0,
        },
      });

      // R1 & R2: Measured cost fields carry no method and no confidence
      expect(trace.context.tokens).toEqual({ value: 250, provenance: "measured" });
      expect(trace.llm.calls).toEqual({ value: 2, provenance: "measured" });
      expect(trace.llm.totalTokens).toEqual({ value: 600, provenance: "measured" });
      expect(trace.llm.inputTokens).toEqual({ value: 450, provenance: "measured" });
      expect(trace.llm.outputTokens).toEqual({ value: 150, provenance: "measured" });
      expect(trace.rounds).toEqual({ value: 1, provenance: "measured" });

      // Decision block
      expect(trace.decision).toBeDefined();
      expect(trace.decision!.durationMs).toEqual({ value: 45, provenance: "measured" });
      expect(trace.decision!.llmCalls).toEqual({ value: 0, provenance: "measured" });
      // Derived costShare must carry method per R3
      expect(trace.decision!.costShare?.provenance).toBe("estimated");
      expect(trace.decision!.costShare?.method).toBe("decisionMs/totalRunMs");

      // Outcome is accurately recorded
      expect(trace.result.success).toBe(true);
      expect(trace.validation).toHaveLength(2);

      // R6 gate passes without violations
      const violations = validateTraceProvenance(trace);
      expect(violations).toEqual([]);
    });
  });

  describe("End-to-End Real Worker Arm Execution", () => {
    it("runs runEffBench with TypeSafe-JEV worker and records real tokens, calls, and outcomes", async () => {
      // Mock fetch returning realistic LLM completion + usage metrics
      const mockFetch: typeof globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              succeeded: { type: "noul", noul: 0.93 },
            },
            usage: { input_tokens: 100, output_tokens: 125 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const baselineRun = await runEffBench({
        mode: "baseline",
        limit: 4,
        outPath: baselineOut,
        worker: "typesafe-jev",
        apiKey: "tsk-bench",
        fetch: mockFetch,
        // An operator-supplied command really runs; the Jev worker judges it.
        validationCommands: ["node --version"],
      });

      expect(baselineRun.tasksRun).toBe(4);
      expect(baselineRun.provenanceViolations).toEqual([]);

      const baselineTraces: TaskTrace[] = readFileSync(baselineOut, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as TaskTrace);

      expect(baselineTraces).toHaveLength(4);
      for (const trace of baselineTraces) {
        expect(validateTraceProvenance(trace)).toEqual([]);
        // The jev worker's real LLM cost is the System One judgment call:
        // one per executed task, tokens from the usage block (100+125).
        expect(trace.llm.calls.value).toBe(1);
        expect(trace.llm.calls.provenance).toBe("measured");
        expect(trace.llm.totalTokens?.value).toBe(225);
        expect(trace.llm.totalTokens?.provenance).toBe("measured");
        expect(trace.result.success).toBe(true);
      }

      // Shadow arm does the same work; it only records the advisory.
      const shadowRun = await runEffBench({
        mode: "shadow",
        limit: 4,
        outPath: shadowOut,
        worker: "typesafe-jev",
        apiKey: "tsk-bench",
        fetch: mockFetch,
        validationCommands: ["node --version"],
      });

      expect(shadowRun.tasksRun).toBe(4);
      expect(shadowRun.provenanceViolations).toEqual([]);
    });
  });

  describe("A/B Comparison Metrics (Token Savings & Call Reduction)", () => {
    it("correctly computes token savings rate and LLM call reduction rate between arms", () => {
      const armBaselinePath = join(outDir, "ab-baseline.jsonl");
      const armShadowPath = join(outDir, "ab-shadow.jsonl");

      // Baseline: 4 tasks, 1 call each, 1000 tokens each -> 4 calls, 4000 tokens, avgRounds 1.5
      const bTraces: TaskTrace[] = [
        buildRealWorkerTrace({
          task: { text: "Task 1", category: "single-file" },
          worker: "typesafe-jev",
          mode: "baseline",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 1000,
          success: true,
          rounds: 2,
          contextTokens: 300,
          llmCalls: 1,
          totalTokens: 1000,
        }),
        buildRealWorkerTrace({
          task: { text: "Task 2", category: "single-file" },
          worker: "typesafe-jev",
          mode: "baseline",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 1000,
          success: true,
          rounds: 1,
          contextTokens: 300,
          llmCalls: 1,
          totalTokens: 1000,
        }),
        buildRealWorkerTrace({
          task: { text: "Task 3", category: "query" },
          worker: "typesafe-jev",
          mode: "baseline",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 1000,
          success: true,
          rounds: 2,
          contextTokens: 300,
          llmCalls: 1,
          totalTokens: 1000,
        }),
        buildRealWorkerTrace({
          task: { text: "Task 4", category: "query" },
          worker: "typesafe-jev",
          mode: "baseline",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 1000,
          success: true,
          rounds: 1,
          contextTokens: 300,
          llmCalls: 1,
          totalTokens: 1000,
        }),
      ];

      // Shadow: Task 1 FRESH (600 tok), Task 2 ADAPT (400 tok), Tasks 3 & 4 REUSE (0 tok, 0 calls)
      // Total calls = 2 (50% reduction from 4)
      // Total tokens = 1000 (75% savings from 4000)
      // Avg rounds = 1.0 (vs 1.5)
      const sTraces: TaskTrace[] = [
        buildRealWorkerTrace({
          task: { text: "Task 1", category: "single-file" },
          worker: "typesafe-jev",
          mode: "shadow",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 800,
          success: true,
          rounds: 1,
          contextTokens: 200,
          llmCalls: 1,
          totalTokens: 600,
          advisory: { taskId: "t1", reuseMode: "FRESH", durationMs: 20, llmCalls: 0 },
        }),
        buildRealWorkerTrace({
          task: { text: "Task 2", category: "single-file" },
          worker: "typesafe-jev",
          mode: "shadow",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 600,
          success: true,
          rounds: 1,
          contextTokens: 150,
          llmCalls: 1,
          totalTokens: 400,
          advisory: { taskId: "t2", reuseMode: "ADAPT", durationMs: 20, llmCalls: 0 },
        }),
        buildRealWorkerTrace({
          task: { text: "Task 3", category: "query" },
          worker: "typesafe-jev",
          mode: "shadow",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 20,
          success: true,
          rounds: 1,
          contextTokens: 0,
          llmCalls: 0,
          totalTokens: 0,
          advisory: { taskId: "t3", reuseMode: "REUSE", durationMs: 20, llmCalls: 0 },
        }),
        buildRealWorkerTrace({
          task: { text: "Task 4", category: "query" },
          worker: "typesafe-jev",
          mode: "shadow",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          totalDurationMs: 20,
          success: true,
          rounds: 1,
          contextTokens: 0,
          llmCalls: 0,
          totalTokens: 0,
          advisory: { taskId: "t4", reuseMode: "REUSE", durationMs: 20, llmCalls: 0 },
        }),
      ];

      writeFileSync(armBaselinePath, bTraces.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
      writeFileSync(armShadowPath, sTraces.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

      const report = compareEffBench(armBaselinePath, armShadowPath);

      expect(report.ok).toBe(true);
      expect(report.tasksCompared).toBe(4);
      expect(report.comparison).toBeDefined();

      // Token Savings: (4000 - 1000) / 4000 = 0.75 (75%)
      expect(report.comparison!.baselineTokens).toBe(4000);
      expect(report.comparison!.shadowTokens).toBe(1000);
      expect(report.comparison!.tokenSavingsRate).toBe(0.75);
      expect(report.tokenSavingsRate).toBe(0.75);

      // LLM Call Reduction: (4 - 2) / 4 = 0.50 (50%)
      expect(report.comparison!.baselineCalls).toBe(4);
      expect(report.comparison!.shadowCalls).toBe(2);
      expect(report.comparison!.llmCallReductionRate).toBe(0.5);
      expect(report.llmCallReductionRate).toBe(0.5);

      // Rounds comparison
      expect(report.comparison!.roundsDiff).toBe(-0.5);
      expect(report.roundsDiff).toBe(-0.5);
    });
  });

  describe("R1-R6 Defense Gate Refusal", () => {
    it("strictly refuses comparison when traces contain provenance violations", () => {
      const cleanPath = join(outDir, "gate-clean.jsonl");
      const dirtyPath = join(outDir, "gate-dirty.jsonl");

      const cleanTrace = buildRealWorkerTrace({
        task: { text: "Task Valid", category: "single-file" },
        worker: "typesafe-jev",
        mode: "baseline",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        totalDurationMs: 500,
        success: true,
        rounds: 1,
        contextTokens: 200,
        llmCalls: 1,
        totalTokens: 500,
      });

      writeFileSync(cleanPath, `${JSON.stringify(cleanTrace)}\n`, "utf8");

      // Case 1: Estimated without method (R3 violation)
      const dirty1: TaskTrace = {
        ...cleanTrace,
        llm: {
          ...cleanTrace.llm,
          totalTokens: { value: 500, provenance: "estimated" }, // missing method
        },
      };
      writeFileSync(dirtyPath, `${JSON.stringify(dirty1)}\n`, "utf8");
      let report = compareEffBench(cleanPath, dirtyPath);
      expect(report.ok).toBe(false);
      expect(report.refusedBy?.some((r) => r.includes("estimated values require a method string"))).toBe(
        true
      );

      // Case 2: Measured carrying method (R2 violation)
      const dirty2: TaskTrace = {
        ...cleanTrace,
        llm: {
          ...cleanTrace.llm,
          calls: { value: 1, provenance: "measured", method: "illegal-method" },
        },
      };
      writeFileSync(dirtyPath, `${JSON.stringify(dirty2)}\n`, "utf8");
      report = compareEffBench(cleanPath, dirtyPath);
      expect(report.ok).toBe(false);
      expect(report.refusedBy?.some((r) => r.includes("measured values do not carry a method"))).toBe(
        true
      );

      // Case 3: Value is not a finite number
      const dirty3: TaskTrace = {
        ...cleanTrace,
        rounds: { value: NaN, provenance: "measured" },
      };
      writeFileSync(dirtyPath, `${JSON.stringify(dirty3)}\n`, "utf8");
      report = compareEffBench(cleanPath, dirtyPath);
      expect(report.ok).toBe(false);
      expect(report.refusedBy?.some((r) => r.includes("value is not a finite number"))).toBe(true);
    });
  });

  describe("50-Task Corpus Integrity", () => {
    it("loads and verifies the full 50-task corpus", () => {
      const tasks = loadCorpus();
      expect(tasks).toHaveLength(50);
      const cohorts = tasks.reduce<Record<string, number>>((acc, t) => {
        acc[t.cohort] = (acc[t.cohort] ?? 0) + 1;
        return acc;
      }, {});
      expect(cohorts).toEqual({ repetition: 20, regular: 15, complex: 10, failure: 5 });
    });
  });
});
