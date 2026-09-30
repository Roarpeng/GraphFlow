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
  createLocalCommandWorker,
  createTypeSafeJevWorker,
  estimated,
  measured,
  parseEffTaskCorpus,
  runBrokeredExecution,
  validateTraceProvenance,
  type BrokerPolicy,
  type EffTask,
  type Measurement,
  type TaskTrace,
  type TraceTaskInfo,
  type TraceToolUse,
  type TypeSafeJevObservation,
  type WorkerAdapter,
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

export interface RealWorkerObservation {
  task: TraceTaskInfo;
  worker: string;
  mode: "baseline" | "shadow";
  startedAt: string;
  finishedAt: string;
  /** Wall-clock ms of the execution. Measured. */
  totalDurationMs: number;
  /** Actual execution outcome: pass or fail. */
  success: boolean;
  /** Attempts or rounds consumed. */
  rounds?: number | Measurement;
  attempts?: number;
  /** Anchors in context. */
  anchors?: number;
  /** Context token count (number wrapped as measured(n), or explicit Measurement). */
  contextTokens?: number | Measurement;
  /** Total LLM calls (number wrapped as measured(n), or explicit Measurement). */
  llmCalls?: number | Measurement;
  /** LLM tokens. Numbers wrapped as measured(n), or explicit Measurement. */
  totalTokens?: number | Measurement;
  inputTokens?: number | Measurement;
  outputTokens?: number | Measurement;
  costUsd?: number | Measurement;
  /** Tool usage if any. */
  tools?: TraceToolUse[];
  /** Validation checks performed. */
  validation?: Array<{ name: string; passed: boolean }>;
  /** Failure detail if any. */
  failure?: { stage: string; reason: string };
  /** Efficiency advisory if in shadow mode. */
  advisory?: {
    taskId: string;
    reuseMode: "REUSE" | "ADAPT" | "FRESH";
    durationMs: number;
    llmCalls: number;
  };
}

/**
 * Build a TaskTrace from real worker execution observations.
 * Ensures all cost-bearing numbers strictly follow the Measurement Contract (R1-R6).
 */
export function buildRealWorkerTrace(obs: RealWorkerObservation): TaskTrace {
  const toMeasurement = (val: number | Measurement | undefined, fallback: number): Measurement => {
    if (val === undefined) return measured(fallback);
    if (typeof val === "number") return measured(val);
    return val;
  };

  const contextTokens = toMeasurement(obs.contextTokens, 0);
  const llmCalls = toMeasurement(obs.llmCalls, 0);
  const rounds =
    obs.rounds !== undefined
      ? typeof obs.rounds === "number"
        ? measured(Math.max(1, obs.rounds))
        : obs.rounds
      : measured(Math.max(1, obs.attempts ?? 1));

  const trace: TaskTrace = {
    schemaVersion: "1.0",
    traceId: `${obs.mode}-${obs.task.taskId ?? obs.task.text.slice(0, 24)}`,
    task: obs.task,
    run: {
      worker: obs.worker,
      mode: obs.mode,
      startedAt: obs.startedAt,
      finishedAt: obs.finishedAt,
    },
    context: {
      tokens: contextTokens,
      anchors: obs.anchors ?? 0,
      cacheHit: obs.advisory?.reuseMode === "REUSE",
    },
    llm: {
      calls: llmCalls,
      ...(obs.inputTokens !== undefined ? { inputTokens: toMeasurement(obs.inputTokens, 0) } : {}),
      ...(obs.outputTokens !== undefined ? { outputTokens: toMeasurement(obs.outputTokens, 0) } : {}),
      ...(obs.totalTokens !== undefined ? { totalTokens: toMeasurement(obs.totalTokens, 0) } : {}),
      ...(obs.costUsd !== undefined ? { costUsd: toMeasurement(obs.costUsd, 0) } : {}),
    },
    tools: obs.tools ?? [],
    rounds,
    validation: obs.validation ?? [],
    result: { success: obs.success },
    ...(obs.failure ? { failure: obs.failure } : {}),
  };

  if (obs.advisory) {
    const share =
      obs.totalDurationMs > 0 ? obs.advisory.durationMs / obs.totalDurationMs : 0;
    trace.decision = {
      reuseMode: obs.advisory.reuseMode,
      durationMs: measured(obs.advisory.durationMs),
      llmCalls: measured(obs.advisory.llmCalls),
      costShare: estimated(
        Number(share.toFixed(4)),
        "decisionMs/totalRunMs",
        0.9
      ),
    };
  }

  return trace;
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

export interface EffBenchRunOptions {
  mode: "baseline" | "shadow";
  limit?: number;
  outPath: string;
  corpusPath?: string;
  /** Worker arm: baseline/bridge (offline) or real worker adapter (TypeSafe-JEV / Local). */
  worker?: "baseline" | "bridge" | "typesafe-jev" | "local" | WorkerAdapter;
  provider?: "deepseek" | "openai" | "local" | string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  brokerPolicy?: Partial<BrokerPolicy>;
  workerAdapter?: WorkerAdapter;
  createWorker?: (task: EffTask, summary: RunTaskSummary) => WorkerAdapter;
}

function resolveWorker(options: EffBenchRunOptions): WorkerAdapter | undefined {
  if (options.workerAdapter) {
    return options.workerAdapter;
  }
  if (typeof options.worker === "object" && options.worker !== null && "prepare" in options.worker) {
    return options.worker;
  }
  if (options.worker === "typesafe-jev") {
    // System One (Jev) only — the judgment endpoint. DEEPSEEK/OPENAI keys are
    // deliberately NOT fallbacks: different services, different keys (the old
    // cross-fallback produced guaranteed-401 "cannot connect" runs). A task
    // EXECUTING model belongs to a different worker (local command /
    // external-cli); jev judges outcomes.
    return createTypeSafeJevWorker({
      name: "typesafe-jev",
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.apiKey !== undefined
        ? { apiKey: options.apiKey }
        : { ...(process.env.TYPESAFE_API_KEY ? { apiKey: process.env.TYPESAFE_API_KEY } : {}) }),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  if (options.worker === "local") {
    return createLocalCommandWorker({ name: "local-command" });
  }
  return undefined;
}

export async function runEffBench(options: EffBenchRunOptions): Promise<EffBenchRunSummary> {
  const tasks = loadCorpus(options.corpusPath).slice(0, options.limit ?? 50);
  const sandbox = makeSandbox();
  const traces: TaskTrace[] = [];
  const violations: string[] = [];
  const startedTotal = Date.now();

  const isRealWorker =
    (options.worker && options.worker !== "baseline" && options.worker !== "bridge") ||
    options.workerAdapter !== undefined ||
    options.createWorker !== undefined;

  const defaultWorker = isRealWorker ? resolveWorker(options) : undefined;
  const client = createGraphClient(resolveConfig(sandbox.configPath));

  try {
    for (const task of tasks) {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      let summary: RunTaskSummary;
      try {
        summary = await runTaskResult(task.text, sandbox.configPath);
      } catch (error) {
        summary = {
          status: "HUMAN_REVIEW_REQUIRED",
          attempts: 0,
          feedback: `crashed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const runResultDurationMs = Date.now() - t0;

      if (summary.episodeId) {
        try {
          await updateEpisodeOutcome(
            client,
            summary.episodeId,
            task.cohort === "failure" ? "fail" : "pass"
          );
        } catch {
          // simulation scaffolding closure
        }
      }

      if (!isRealWorker) {
        // Offline bridge path (deterministic v0 packaging + advisory pipeline)
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
          totalDurationMs: runResultDurationMs,
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
      } else {
        // Real Worker execution arm
        const worker = options.createWorker ? options.createWorker(task, summary) : defaultWorker!;

        if (options.mode === "shadow" && summary.advisory?.reuseMode === "REUSE") {
          // REUSE verdict in shadow mode: execution bypassed, 0 LLM calls, cached pass
          const trace = buildRealWorkerTrace({
            task: {
              text: task.text,
              category: task.category,
              ...(summary.advisory ? { taskId: summary.advisory.taskId } : {}),
            },
            worker: worker.name,
            mode: options.mode,
            startedAt,
            finishedAt: new Date().toISOString(),
            totalDurationMs: summary.advisory.decision.durationMs,
            success: true,
            rounds: 1,
            contextTokens: measured(0),
            llmCalls: measured(0),
            totalTokens: measured(0),
            validation: [{ name: "cache-reuse", passed: true }],
            advisory: {
              taskId: summary.advisory.taskId,
              reuseMode: summary.advisory.reuseMode,
              durationMs: summary.advisory.decision.durationMs,
              llmCalls: summary.advisory.decision.llmCalls,
            },
          });
          violations.push(...validateTraceProvenance(trace).map((v) => `${task.id}: ${v}`));
          traces.push(trace);
        } else {
          // Worker execution through Broker
          let validationCommands: string[] = [];
          if (summary.advisory?.validation && summary.advisory.validation.length > 0) {
            validationCommands = summary.advisory.validation;
          } else if (task.cohort === "failure") {
            validationCommands = [`node -e "process.exit(1)"`];
          } else {
            validationCommands = [`node -e "process.exit(0)"`];
          }

          const brokerPolicy: BrokerPolicy = {
            maxRounds: summary.advisory?.worker.maxRounds ?? 2,
            totalBudgetMs: 60_000,
            stopOnValidationPass: true,
            ...options.brokerPolicy,
          };

          const brokerResult = await runBrokeredExecution(
            { validation: validationCommands, policy: brokerPolicy },
            worker
          );

          let totalLlmCalls = 0;
          let totalTokens = 0;
          let promptTokens = 0;
          let completionTokens = 0;
          let hasTokenMeasurement = false;

          for (const obs of brokerResult.observations) {
            const jevObs = obs as TypeSafeJevObservation;
            if (jevObs.measurements) {
              if (jevObs.measurements.totalTokens) {
                totalTokens += jevObs.measurements.totalTokens.value;
                hasTokenMeasurement = true;
              }
              if (jevObs.measurements.judgmentTokens) {
                // System One judgment usage (in+out) — the real LLM cost of
                // the jev worker under the new contract.
                totalTokens += jevObs.measurements.judgmentTokens.value;
                hasTokenMeasurement = true;
              }
              if (jevObs.measurements.promptTokens) {
                promptTokens += jevObs.measurements.promptTokens.value;
              }
              if (jevObs.measurements.completionTokens) {
                completionTokens += jevObs.measurements.completionTokens.value;
              }
            }
            // A judgment call happened exactly when validate() marked the
            // observation typeSafeValid (fail-open runs are exit-code only).
            if (jevObs.typeSafeValid === true) {
              totalLlmCalls += 1;
            }
          }

          const contextChars = summary.executionDescriptor?.context?.length ?? 0;
          const contextTokensCount =
            promptTokens > 0 ? promptTokens : Math.ceil(contextChars / 4);

          const trace = buildRealWorkerTrace({
            task: {
              text: task.text,
              category: task.category,
              ...(summary.advisory ? { taskId: summary.advisory.taskId } : {}),
            },
            worker: worker.name,
            mode: options.mode,
            startedAt,
            finishedAt: new Date().toISOString(),
            totalDurationMs: brokerResult.totalDurationMs + runResultDurationMs,
            success: brokerResult.status === "completed",
            rounds: brokerResult.rounds,
            contextTokens: measured(contextTokensCount),
            llmCalls: measured(totalLlmCalls),
            ...(hasTokenMeasurement ? { totalTokens: measured(totalTokens) } : {}),
            ...(promptTokens > 0 ? { inputTokens: measured(promptTokens) } : {}),
            ...(completionTokens > 0 ? { outputTokens: measured(completionTokens) } : {}),
            validation: brokerResult.validation?.checks ?? [],
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
      }
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

export interface ComparisonMetrics {
  tokenSavingsRate: number;
  llmCallReductionRate: number;
  roundsDiff: number;
  roundsReductionRate: number;
  baselineTokens: number;
  shadowTokens: number;
  baselineCalls: number;
  shadowCalls: number;
}

export interface EffBenchCompareReport {
  ok: boolean;
  refusedBy?: string[];
  tasksCompared?: number;
  baseline?: ArmStats;
  shadow?: ArmStats;
  comparison?: ComparisonMetrics;
  tokenSavingsRate?: number;
  llmCallReductionRate?: number;
  roundsDiff?: number;
}

export interface ArmStats {
  avgContextTokens: number;
  totalContextTokens?: number;
  totalLlmTokens?: number;
  totalTokens?: number;
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
    const totalContextTokens = traces.reduce((acc, t) => acc + t.context.tokens.value, 0);
    const totalLlmTokens = traces.reduce((acc, t) => acc + (t.llm.totalTokens?.value ?? 0), 0);
    const totalTokens = totalLlmTokens > 0 ? totalLlmTokens : totalContextTokens;

    return {
      avgContextTokens: Math.round(totalContextTokens / n),
      totalContextTokens,
      totalLlmTokens,
      totalTokens,
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

  const baselineStats = arm(baseline);
  const shadowStats = arm(shadow);

  // Token comparison (prefer totalTokens / LLM tokens if present, else context tokens)
  const baselineTokens = baselineStats.totalTokens ?? baselineStats.totalContextTokens ?? 0;
  const shadowTokens = shadowStats.totalTokens ?? shadowStats.totalContextTokens ?? 0;
  const tokenSavingsRate =
    baselineTokens > 0
      ? Number(((baselineTokens - shadowTokens) / baselineTokens).toFixed(4))
      : 0;

  // LLM call reduction comparison
  const baselineCalls = baselineStats.totalLlmCalls;
  const shadowCalls = shadowStats.totalLlmCalls;
  const llmCallReductionRate =
    baselineCalls > 0
      ? Number(((baselineCalls - shadowCalls) / baselineCalls).toFixed(4))
      : 0;

  // Rounds comparison
  const roundsDiff = Number((shadowStats.avgRounds - baselineStats.avgRounds).toFixed(2));
  const roundsReductionRate =
    baselineStats.avgRounds > 0
      ? Number(
          ((baselineStats.avgRounds - shadowStats.avgRounds) / baselineStats.avgRounds).toFixed(4)
        )
      : 0;

  const comparison: ComparisonMetrics = {
    tokenSavingsRate,
    llmCallReductionRate,
    roundsDiff,
    roundsReductionRate,
    baselineTokens,
    shadowTokens,
    baselineCalls,
    shadowCalls,
  };

  return {
    ok: true,
    tasksCompared: Math.min(baseline.length, shadow.length),
    baseline: baselineStats,
    shadow: shadowStats,
    comparison,
    tokenSavingsRate,
    llmCallReductionRate,
    roundsDiff,
  };
}
