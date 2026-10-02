/**
 * Efficiency benchmark core (2.x plan Step A/B): run the 50-task corpus
 * through graphflow_run in baseline and shadow arms, emit provenance-gated
 * TaskTrace JSONL, and compare arms.
 *
 * Scope, stated once so nothing downstream over-claims:
 *  - bridge arms (default): a temp workspace with no LLM keys drives the
 *    bridge path, so every run is PACKAGED and delegated; no worker executes.
 *    These arms measure packaging/advising cost only. `result.success` is the
 *    packaging status, never a task outcome, and every trace is `judged: false`.
 *  - worker arms: a real WorkerAdapter runs the validation commands the
 *    substrate advisory carried (or an explicit operator override) through the
 *    broker. Only commands that actually ran produce validation entries. No
 *    oracle runs here either (oracle-judged runs live in
 *    packages/efficiency-agent bench-runner), so these traces are unjudged too.
 *  - shadow = the advisory is RECORDED exactly as the substrate returned it and
 *    never acted on; both arms do identical work.
 *
 * One sandbox is shared across tasks on purpose: episodes accumulate, so later
 * repetition-cohort siblings hit real similar-episode signals. Episode outcomes
 * are never written by this runner — it has no task outcome to report.
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
  proxy,
  runBrokeredExecution,
  validateTraceProvenance,
  weakestProvenance,
  type BrokerPolicy,
  type EffTask,
  type Measurement,
  type Provenance,
  type TaskTrace,
  type TraceTaskInfo,
  type TraceToolUse,
  type TypeSafeJevObservation,
  type WorkerAdapter,
  type WorkerCommand,
  type WorkerObservation,
} from "../packages/efficiency-agent/src/index";
import { runTaskResult } from "../src/surfaces/cli/runtime";
import type { RunTaskSummary } from "../src/surfaces/cli/runtime/types";

export const CORPUS_PATH = join(
  __dirname,
  "..",
  "packages",
  "efficiency-agent",
  "benchmarks",
  "golden-v1.jsonl"
);

export const BRIDGE_SCOPE_NOTE =
  "bridge mode: graphflow_run packaging only, no worker executed — numbers measure packaging/advising cost; " +
  "success rate N/A (0 judged traces); result.success is packaging status, not a task outcome";

export const WORKER_SCOPE_NOTE =
  "worker mode: validation commands from the substrate advisory (or --validation override) ran through the broker; " +
  "no oracle judged the task, so success rate is N/A (0 judged traces)";

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
  /** Observed execution result (NOT an oracle verdict unless `judged` is true). */
  success: boolean;
  /** True only when an oracle judged `success`. Defaults to false. */
  judged?: boolean;
  /** Rounds consumed; one of `rounds` / `attempts` is required. */
  rounds?: number | Measurement;
  attempts?: number;
  /** Anchors in context. */
  anchors?: number;
  /** A cache entry was actually reused. Never inferred from an advisory verdict. */
  cacheHit?: boolean;
  /** Context tokens. A bare number asserts an instrument reading (measured). */
  contextTokens: number | Measurement;
  /** Total LLM calls. A bare number asserts an instrument reading (measured). */
  llmCalls: number | Measurement;
  /** LLM tokens. Bare numbers assert instrument readings (measured). */
  totalTokens?: number | Measurement;
  inputTokens?: number | Measurement;
  outputTokens?: number | Measurement;
  costUsd?: number | Measurement;
  /** Tool usage if any. */
  tools?: TraceToolUse[];
  /** Checks from commands that actually ran. */
  validation?: Array<{ name: string; passed: boolean }>;
  validationStatus?: TaskTrace["validationStatus"];
  /** Failure detail if any. */
  failure?: { stage: string; reason: string };
  /** Efficiency advisory if in shadow mode, recorded as the substrate returned it. */
  advisory?: {
    taskId: string;
    reuseMode: "REUSE" | "ADAPT" | "FRESH";
    durationMs: number | Measurement;
    llmCalls: number;
  };
}

const asMeasurement = (val: number | Measurement): Measurement =>
  typeof val === "number" ? measured(val) : val;

/**
 * Build a TaskTrace from real worker execution observations.
 * Never fills in a cost-bearing number the caller did not observe (R1-R6).
 */
export function buildRealWorkerTrace(obs: RealWorkerObservation): TaskTrace {
  let rounds: Measurement;
  if (obs.rounds !== undefined) {
    rounds = typeof obs.rounds === "number" ? measured(obs.rounds) : obs.rounds;
  } else if (obs.attempts !== undefined) {
    rounds = measured(obs.attempts);
  } else {
    throw new Error("buildRealWorkerTrace: rounds or attempts must be observed");
  }

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
      tokens: asMeasurement(obs.contextTokens),
      anchors: obs.anchors ?? 0,
      cacheHit: obs.cacheHit ?? false,
    },
    llm: {
      calls: asMeasurement(obs.llmCalls),
      ...(obs.inputTokens !== undefined ? { inputTokens: asMeasurement(obs.inputTokens) } : {}),
      ...(obs.outputTokens !== undefined ? { outputTokens: asMeasurement(obs.outputTokens) } : {}),
      ...(obs.totalTokens !== undefined ? { totalTokens: asMeasurement(obs.totalTokens) } : {}),
      ...(obs.costUsd !== undefined ? { costUsd: asMeasurement(obs.costUsd) } : {}),
    },
    tools: obs.tools ?? [],
    rounds,
    validation: obs.validation ?? [],
    ...(obs.validationStatus ? { validationStatus: obs.validationStatus } : {}),
    result: { success: obs.success },
    judged: obs.judged ?? false,
    ...(obs.failure ? { failure: obs.failure } : {}),
  };

  if (obs.advisory) {
    const decisionDuration = asMeasurement(obs.advisory.durationMs);
    const share =
      obs.totalDurationMs > 0 ? decisionDuration.value / obs.totalDurationMs : 0;
    trace.decision = {
      reuseMode: obs.advisory.reuseMode,
      durationMs: decisionDuration,
      llmCalls: measured(obs.advisory.llmCalls),
      costShare:
        decisionDuration.provenance === "measured"
          ? estimated(Number(share.toFixed(4)), "decisionMs/totalRunMs", 0.9)
          : proxy(Number(share.toFixed(4)), "decisionMs/totalRunMs (decision duration not instrumented)", 0),
    };
  }

  return trace;
}

export interface EffBenchRunSummary {
  mode: "baseline" | "shadow";
  /** bridge = packaging only (no worker executed); worker = broker ran real commands. */
  executionMode: "bridge" | "worker";
  tasksRun: number;
  /** Tasks the substrate packaged (DELEGATED, not an error recovery). Packaging status only. */
  packagedCount: number;
  /** Tasks where at least one validation command actually executed (always 0 in bridge mode). */
  executedCount: number;
  /** Traces whose result.success an oracle judged. This runner never judges. */
  judgedTraces: number;
  /** Success rate over judged traces; null = N/A (no judged traces). */
  successRate: number | null;
  provenanceViolations: string[];
  byCohort: Record<string, number>;
  reuseModeDistribution: Record<string, number>;
  /** Mean of instrumented (measured) decision durations only. */
  avgDecisionDurationMs: number;
  totalRunMs: number;
  outPath: string;
  /** What these numbers do and do not measure. */
  scope: string;
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
  /**
   * Operator-supplied real commands for worker arms, used when the substrate
   * advisory carries no validation. Never chosen per task or per cohort.
   */
  validationCommands?: string[];
  /** Substrate entry point (graphflow_run). Defaults to runTaskResult; injectable for tests. */
  runTask?: (text: string, configPath: string) => Promise<RunTaskSummary>;
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

/**
 * The substrate's no-LLM catch path converts a crash into DELEGATED with a stub
 * descriptor and a constant-0 decision duration. That is not a packaging success.
 */
function isRecoveredFallback(summary: RunTaskSummary): boolean {
  return summary.status === "DELEGATED" && /\(recovered from: /.test(summary.feedback);
}

function descriptorContextTokens(summary: RunTaskSummary): Measurement {
  // The summary exposes no token counts; chars/4 over the packaged context is
  // a stand-in and must never be labelled measured.
  return proxy(
    Math.ceil((summary.executionDescriptor?.context?.length ?? 0) / 4),
    "descriptor-chars/4",
    0.6
  );
}

function advisoryOf(summary: RunTaskSummary, recovered: boolean): RealWorkerObservation["advisory"] {
  const advisory = summary.advisory;
  if (!advisory) return undefined;
  return {
    taskId: advisory.taskId,
    reuseMode: advisory.reuseMode,
    durationMs: recovered
      ? proxy(advisory.decision.durationMs, "substrate fallback advisory: decision duration not instrumented", 0)
      : advisory.decision.durationMs,
    llmCalls: advisory.decision.llmCalls,
  };
}

/** Checks the broker writes without running anything; they are not validation evidence. */
const SYNTHETIC_CHECKS = new Set(["no-validation-command", "prepare-threw"]);

function countingWorker(worker: WorkerAdapter): { adapter: WorkerAdapter; executions: () => number } {
  let executions = 0;
  return {
    adapter: {
      name: worker.name,
      prepare: (validation: string[]) => worker.prepare(validation),
      execute: (command: WorkerCommand): Promise<WorkerObservation> => {
        executions += 1;
        return worker.execute(command);
      },
      validate: (observation: WorkerObservation) => worker.validate(observation),
      stop: () => worker.stop(),
    },
    executions: () => executions,
  };
}

export async function runEffBench(options: EffBenchRunOptions): Promise<EffBenchRunSummary> {
  const tasks = loadCorpus(options.corpusPath).slice(0, options.limit ?? 50);
  const sandbox = makeSandbox();
  const runTask = options.runTask ?? ((text: string, configPath: string) => runTaskResult(text, configPath));
  const traces: TaskTrace[] = [];
  const violations: string[] = [];
  const startedTotal = Date.now();
  let packagedCount = 0;
  let executedCount = 0;

  const isRealWorker =
    (options.worker && options.worker !== "baseline" && options.worker !== "bridge") ||
    options.workerAdapter !== undefined ||
    options.createWorker !== undefined;

  const defaultWorker = isRealWorker ? resolveWorker(options) : undefined;

  try {
    for (const task of tasks) {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      let summary: RunTaskSummary;
      try {
        summary = await runTask(task.text, sandbox.configPath);
      } catch (error) {
        summary = {
          status: "HUMAN_REVIEW_REQUIRED",
          attempts: 0,
          feedback: `crashed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const runResultDurationMs = Date.now() - t0;
      const recovered = isRecoveredFallback(summary);
      const packaged = summary.status === "DELEGATED" && !recovered;
      if (packaged) packagedCount += 1;
      const packagingFailure = packaged
        ? undefined
        : { stage: "packaging", reason: `${summary.status}: ${summary.feedback}`.slice(0, 500) };
      const taskInfo: TraceTaskInfo = {
        text: task.text,
        category: task.category,
        ...(summary.advisory ? { taskId: summary.advisory.taskId } : {}),
      };
      const advisory = options.mode === "shadow" ? advisoryOf(summary, recovered) : undefined;

      let trace: TaskTrace;
      if (!isRealWorker) {
        // Bridge path: packaging + advisory only. buildRunTrace sets
        // result.success = packaged and judged = false.
        trace = buildRunTrace({
          task: taskInfo,
          worker: "graphflow-bridge",
          mode: options.mode,
          startedAt,
          finishedAt: new Date().toISOString(),
          totalDurationMs: runResultDurationMs,
          packaged,
          descriptorContextChars: summary.executionDescriptor?.context?.length ?? 0,
          attempts: summary.attempts,
          anchors: summary.advisory?.context.requiredAnchors.length ?? 0,
          ...(advisory
            ? {
                advisory: {
                  taskId: advisory.taskId,
                  reuseMode: advisory.reuseMode,
                  durationMs: summary.advisory!.decision.durationMs,
                  llmCalls: advisory.llmCalls,
                },
              }
            : {}),
        });
        trace.validationStatus = "not-run";
        if (packagingFailure) trace.failure = packagingFailure;
        if (recovered && trace.decision) {
          const uninstrumented = asMeasurement(advisory!.durationMs);
          trace.decision.durationMs = uninstrumented;
          trace.decision.costShare = proxy(
            trace.decision.costShare?.value ?? 0,
            "decisionMs/totalRunMs (decision duration not instrumented)",
            0
          );
        }
      } else {
        // Worker arm: identical work in both modes; shadow only records the advisory.
        const worker = options.createWorker ? options.createWorker(task, summary) : defaultWorker!;
        const counted = countingWorker(worker);
        const advisoryValidation = summary.advisory?.validation ?? [];
        const validationCommands =
          advisoryValidation.length > 0 ? advisoryValidation : (options.validationCommands ?? []);

        const brokerPolicy: BrokerPolicy = {
          maxRounds: 2,
          totalBudgetMs: 60_000,
          stopOnValidationPass: true,
          ...options.brokerPolicy,
        };
        const brokerResult = await runBrokeredExecution(
          { validation: validationCommands, policy: brokerPolicy },
          counted.adapter
        );
        const executions = counted.executions();
        if (executions > 0) executedCount += 1;

        let judgmentCalls = 0;
        let judgmentTokens = 0;
        let hasJudgmentTokens = false;
        for (const obs of brokerResult.observations) {
          const jevObs = obs as TypeSafeJevObservation;
          if (jevObs.measurements?.judgmentTokens) {
            judgmentTokens += jevObs.measurements.judgmentTokens.value;
            hasJudgmentTokens = true;
          }
          // A judgment call happened exactly when validate() marked the
          // observation typeSafeValid (fail-open runs are exit-code only).
          if (jevObs.typeSafeValid === true) judgmentCalls += 1;
        }

        const finalChecks = brokerResult.validation?.checks ?? [];
        const validation =
          executions > 0 && !finalChecks.some((c) => SYNTHETIC_CHECKS.has(c.name)) ? finalChecks : [];
        const completed = brokerResult.status === "completed";
        const failure =
          packagingFailure ??
          (completed
            ? undefined
            : executions === 0
              ? {
                  stage: "validate",
                  reason:
                    "no executable validation command (advisory carried none, no override); nothing executed",
                }
              : { stage: "broker", reason: `${brokerResult.status}: ${brokerResult.stopReason ?? "unknown"}` });

        trace = buildRealWorkerTrace({
          task: taskInfo,
          worker: worker.name,
          mode: options.mode,
          startedAt,
          finishedAt: new Date().toISOString(),
          totalDurationMs: brokerResult.totalDurationMs + runResultDurationMs,
          success: completed,
          judged: false,
          rounds: brokerResult.rounds,
          anchors: summary.advisory?.context.requiredAnchors.length ?? 0,
          contextTokens: descriptorContextTokens(summary),
          llmCalls: measured(judgmentCalls),
          ...(hasJudgmentTokens ? { totalTokens: measured(judgmentTokens) } : {}),
          validation,
          validationStatus: executions === 0 ? "not-run" : completed ? "passed" : "failed",
          ...(failure ? { failure } : {}),
          ...(advisory ? { advisory } : {}),
        });
      }
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
      if (decision.durationMs.provenance === "measured") {
        decisionMs += decision.durationMs.value;
        decisionCount += 1;
      }
    }
  });
  const judged = traces.filter((t) => t.judged === true);

  return {
    mode: options.mode,
    executionMode: isRealWorker ? "worker" : "bridge",
    tasksRun: traces.length,
    packagedCount,
    executedCount,
    judgedTraces: judged.length,
    successRate:
      judged.length === 0
        ? null
        : Number((judged.filter((t) => t.result.success).length / judged.length).toFixed(3)),
    provenanceViolations: violations,
    byCohort,
    reuseModeDistribution: reuse,
    avgDecisionDurationMs: decisionCount === 0 ? 0 : Math.round(decisionMs / decisionCount),
    totalRunMs: Date.now() - startedTotal,
    outPath: options.outPath,
    scope: isRealWorker ? WORKER_SCOPE_NOTE : BRIDGE_SCOPE_NOTE,
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
  /** R5: weakest provenance among the token inputs of both arms. */
  tokenProvenance: Provenance;
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
  /** R5: weakest provenance of the token fields that `totalTokens` sums. */
  tokenProvenance: Provenance;
  totalLlmCalls: number;
  avgRounds: number;
  /** Traces whose success an oracle judged. */
  judgedTraces: number;
  /** Success rate over judged traces only; null = N/A. */
  successRate: number | null;
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
    const judged = traces.filter((t) => t.judged === true);
    const totalContextTokens = traces.reduce((acc, t) => acc + t.context.tokens.value, 0);
    const totalLlmTokens = traces.reduce((acc, t) => acc + (t.llm.totalTokens?.value ?? 0), 0);
    const useLlmTokens = totalLlmTokens > 0;
    const totalTokens = useLlmTokens ? totalLlmTokens : totalContextTokens;
    const tokenProvenance = weakestProvenance(
      useLlmTokens
        ? traces.flatMap((t) => (t.llm.totalTokens ? [t.llm.totalTokens.provenance] : []))
        : traces.map((t) => t.context.tokens.provenance)
    );

    return {
      avgContextTokens: Math.round(totalContextTokens / n),
      totalContextTokens,
      totalLlmTokens,
      totalTokens,
      tokenProvenance,
      totalLlmCalls: traces.reduce((acc, t) => acc + t.llm.calls.value, 0),
      avgRounds: Number((traces.reduce((acc, t) => acc + t.rounds.value, 0) / n).toFixed(2)),
      judgedTraces: judged.length,
      successRate:
        judged.length === 0
          ? null
          : Number((judged.filter((t) => t.result.success).length / judged.length).toFixed(3)),
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
    tokenProvenance: weakestProvenance([baselineStats.tokenProvenance, shadowStats.tokenProvenance]),
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
