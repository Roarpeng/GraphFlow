/**
 * Efficiency benchmark core (2.x plan Step A/B): run the 50-task corpus
 * through graphflow_run in baseline and shadow arms, emit provenance-gated
 * TaskTrace JSONL, and compare arms.
 *
 * Offline and deterministic by construction: a temp workspace with no LLM
 * keys drives the bridge path, so every run delegates (the packaging and
 * advising pipeline is what these arms measure — worker-outcome arms arrive
 * with the P2 broker). One sandbox is shared across tasks on purpose:
 * episodes accumulate, so later repetition-cohort siblings hit real
 * similar-episode signals and the ADAPT verdict has something to chew on.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunTrace,
  parseEffTaskCorpus,
  validateTraceProvenance,
  type EffTask,
  type TaskTrace,
} from "../packages/efficiency-agent/src/index";
import { runTaskResult } from "../src/surfaces/cli/runtime";
import type { RunTaskSummary } from "../src/surfaces/cli/runtime/types";
import { createGraphClient } from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import { updateEpisodeOutcome } from "../src/learning/episodic-memory";

export const CORPUS_PATH = join(
  __dirname,
  "..",
  "packages",
  "efficiency-agent",
  "benchmarks",
  "eff-tasks-v1.jsonl"
);

export function loadCorpus(corpusPath: string = CORPUS_PATH): EffTask[] {
  const { tasks, violations } = parseEffTaskCorpus(readFileSync(corpusPath, "utf8"));
  if (violations.length > 0) {
    throw new Error(`Eff benchmark corpus is invalid:\n${violations.join("\n")}`);
  }
  return tasks;
}

function makeSandbox(): { configPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "graphflow-eff-bench-"));
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: join(root, "graph-store.json"),
          maxContextTokens: 1500,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return { configPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface EffBenchRunSummary {
  mode: "baseline" | "shadow";
  tasksRun: number;
  provenanceViolations: string[];
  byCohort: Record<string, number>;
  reuseModeDistribution: Record<string, number>;
  avgDecisionDurationMs: number;
  totalRunMs: number;
  outPath: string;
}

export async function runEffBench(options: {
  mode: "baseline" | "shadow";
  limit?: number;
  outPath: string;
  corpusPath?: string;
}): Promise<EffBenchRunSummary> {
  const tasks = loadCorpus(options.corpusPath).slice(0, options.limit ?? 50);
  const sandbox = makeSandbox();
  const traces: TaskTrace[] = [];
  const violations: string[] = [];
  const startedTotal = Date.now();

  // Episode closure models a real deployment: the flywheel closes runs via
  // report_outcome / hooks, and similarEpisodes scores are OUTCOME-based
  // (pass=1, pending=0, fail=-1). Without closure every bridge episode stays
  // pending at score 0 and the ADAPT verdict can never fire — a benchmark
  // that never closes episodes measures a store no real project has.
  // Failure-cohort tasks close as fail: they must never become reuse bait.
  const client = createGraphClient(resolveConfig(sandbox.configPath));

  try {
    for (const task of tasks) {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      let summary: RunTaskSummary;
      try {
        summary = await runTaskResult(task.text, sandbox.configPath);
      } catch (error) {
        // A deliberate-failure task may still crash the pipeline — that is a
        // finding, recorded as a failed trace, never a bench abort.
        summary = {
          status: "HUMAN_REVIEW_REQUIRED",
          attempts: 0,
          feedback: `crashed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const totalDurationMs = Date.now() - t0;
      if (summary.episodeId) {
        try {
          await updateEpisodeOutcome(
            client,
            summary.episodeId,
            task.cohort === "failure" ? "fail" : "pass"
          );
        } catch {
          // closure is simulation scaffolding; a failed close must not
          // invalidate the run — the advisory just sees a pending episode.
        }
      }
      const trace = buildRunTrace({
        task: {
          text: task.text,
          category: task.category,
          ...(summary.advisory ? { taskId: summary.advisory.taskId } : {}),
        },
        worker: "graphflow-bridge",
        mode: options.mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        totalDurationMs,
        packaged: summary.status === "DELEGATED",
        descriptorContextChars: summary.executionDescriptor?.context?.length ?? 0,
        attempts: summary.attempts,
        anchors: 0,
        ...(options.mode === "shadow" && summary.advisory
          ? {
              advisory: {
                taskId: summary.advisory.taskId,
                reuseMode: summary.advisory.reuseMode,
                durationMs: summary.advisory.decision.durationMs,
                llmCalls: summary.advisory.decision.llmCalls,
              },
            }
          : {}),
      });
      violations.push(...validateTraceProvenance(trace).map((v) => `${task.id}: ${v}`));
      traces.push(trace);
    }
  } finally {
    sandbox.cleanup();
  }

  writeFileSync(options.outPath, traces.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

  const byCohort: Record<string, number> = {};
  const reuse: Record<string, number> = {};
  let decisionMs = 0;
  let decisionCount = 0;
  tasks.forEach((task, i) => {
    byCohort[task.cohort] = (byCohort[task.cohort] ?? 0) + 1;
    const decision = traces[i]?.decision;
    if (decision) {
      reuse[decision.reuseMode] = (reuse[decision.reuseMode] ?? 0) + 1;
      decisionMs += decision.durationMs.value;
      decisionCount += 1;
    }
  });

  return {
    mode: options.mode,
    tasksRun: traces.length,
    provenanceViolations: violations,
    byCohort,
    reuseModeDistribution: reuse,
    avgDecisionDurationMs: decisionCount === 0 ? 0 : Math.round(decisionMs / decisionCount),
    totalRunMs: Date.now() - startedTotal,
    outPath: options.outPath,
  };
}

export interface EffBenchCompareReport {
  ok: boolean;
  refusedBy?: string[];
  tasksCompared?: number;
  baseline?: ArmStats;
  shadow?: ArmStats;
}

export interface ArmStats {
  avgContextTokens: number;
  totalLlmCalls: number;
  avgRounds: number;
  successRate: number;
  avgDecisionDurationMs?: number;
  avgDecisionCostShare?: number;
}

export function readTraces(path: string): TaskTrace[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TaskTrace);
}

export function compareEffBench(baselinePath: string, shadowPath: string): EffBenchCompareReport {
  const baseline = readTraces(baselinePath);
  const shadow = readTraces(shadowPath);

  // R6 gate first: any provenance violation on either side refuses the whole
  // comparison — averaging unprovenanced numbers is the failure mode this
  // benchmark exists to prevent.
  const refusedBy: string[] = [];
  baseline.forEach((t, i) =>
    validateTraceProvenance(t).forEach((v) => refusedBy.push(`baseline[${i}]: ${v}`))
  );
  shadow.forEach((t, i) =>
    validateTraceProvenance(t).forEach((v) => refusedBy.push(`shadow[${i}]: ${v}`))
  );
  if (refusedBy.length > 0) {
    return { ok: false, refusedBy };
  }

  const arm = (traces: TaskTrace[]): ArmStats => {
    const n = traces.length || 1;
    const withDecision = traces.filter((t) => t.decision);
    const m = withDecision.length || 1;
    return {
      avgContextTokens: Math.round(
        traces.reduce((acc, t) => acc + t.context.tokens.value, 0) / n
      ),
      totalLlmCalls: traces.reduce((acc, t) => acc + t.llm.calls.value, 0),
      avgRounds: Number((traces.reduce((acc, t) => acc + t.rounds.value, 0) / n).toFixed(2)),
      successRate: Number((traces.filter((t) => t.result.success).length / n).toFixed(3)),
      ...(withDecision.length > 0
        ? {
            avgDecisionDurationMs: Math.round(
              withDecision.reduce((acc, t) => acc + t.decision!.durationMs.value, 0) / m
            ),
            avgDecisionCostShare: Number(
              (
                withDecision.reduce((acc, t) => acc + (t.decision!.costShare?.value ?? 0), 0) / m
              ).toFixed(4)
            ),
          }
        : {}),
    };
  };

  return {
    ok: true,
    tasksCompared: Math.min(baseline.length, shadow.length),
    baseline: arm(baseline),
    shadow: arm(shadow),
  };
}
