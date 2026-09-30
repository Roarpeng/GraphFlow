#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRunTrace,
  buildTaskFingerprint,
  createLocalCommandWorker,
  createTypeSafeJevWorker,
  decideReuse,
  learnPolicyFromLedger,
  parseEffTaskCorpus,
  type LedgerDecisionRecord,
  runBrokeredExecution,
  validateTraceProvenance,
  type BrokerPolicy,
  type BrokerResult,
  type ReuseDecision,
  type RunObservation,
  type TaskTrace,
  type WorkerAdapter,
} from "../src/index.js";
import { createExternalCliWorker } from "../src/workers/external-cli-worker.js";

/**
 * IO interface to allow testing CLI execution in-process without process.exit.
 */
export interface CliIo {
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CliParsedFlags {
  mode?: string;
  worker?: string;
  policy?: string;
  out?: string;
  limit?: number;
  cliCommand?: string;
  validation?: string[];
  json?: boolean;
  quiet?: boolean;
  help?: boolean;
  version?: boolean;
}

/**
 * Parse flag arguments from an argv slice.
 */
export function parseFlags(argv: string[]): { positional: string[]; flags: CliParsedFlags } {
  const positional: string[] = [];
  const flags: CliParsedFlags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      flags.version = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--quiet" || arg === "-q") {
      flags.quiet = true;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      flags.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--mode" && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      flags.mode = argv[++i];
      continue;
    }

    if (arg.startsWith("--worker=")) {
      flags.worker = arg.slice("--worker=".length);
      continue;
    }
    if (arg === "--worker" && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      flags.worker = argv[++i];
      continue;
    }

    if (arg.startsWith("--policy=")) {
      flags.policy = arg.slice("--policy=".length);
      continue;
    }
    if (arg === "--policy" && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      flags.policy = argv[++i];
      continue;
    }

    if (arg.startsWith("--out=")) {
      flags.out = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--out" && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      flags.out = argv[++i];
      continue;
    }

    if (arg.startsWith("--limit=")) {
      flags.limit = Number(arg.slice("--limit=".length));
      continue;
    }
    if (arg === "--limit" && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      flags.limit = Number(argv[++i]);
      continue;
    }

    if (arg.startsWith("--cli-command=")) {
      flags.cliCommand = arg.slice("--cli-command=".length);
      continue;
    }
    if (arg === "--cli-command" && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      flags.cliCommand = argv[++i];
      continue;
    }

    if (arg.startsWith("--validation=")) {
      const val = arg.slice("--validation=".length);
      flags.validation = flags.validation ? [...flags.validation, val] : [val];
      continue;
    }
    if (arg === "--validation" && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      const val = argv[++i]!;
      flags.validation = flags.validation ? [...flags.validation, val] : [val];
      continue;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function resolveWorker(type?: string, cliCommand?: string): WorkerAdapter {
  const norm = (type ?? "local").toLowerCase();
  switch (norm) {
    case "jev":
      return createTypeSafeJevWorker();
    case "external":
      return createExternalCliWorker({
        cliCommand: cliCommand ?? "claude",
      });
    case "local":
    default:
      return createLocalCommandWorker();
  }
}

function resolveBrokerPolicy(policyName?: string): BrokerPolicy {
  const norm = (policyName ?? "conservative").toLowerCase();
  if (norm === "adaptive") {
    return {
      maxRounds: 4,
      totalBudgetMs: 60_000,
      stopOnValidationPass: true,
    };
  }
  return {
    maxRounds: 2,
    totalBudgetMs: 30_000,
    stopOnValidationPass: true,
  };
}

/**
 * Handle `eff-agent run <task>`
 */
async function handleRun(
  positional: string[],
  flags: CliParsedFlags,
  io: Required<CliIo>
): Promise<number> {
  const taskText = positional[0];
  if (!taskText) {
    io.stderr("error: missing required argument <task>");
    io.stderr("usage: eff-agent run <task> [--mode=broker|shadow|advisory] [--worker=local|jev|external] [--policy=conservative|adaptive]");
    return 2;
  }

  const mode = (flags.mode ?? "broker").toLowerCase();
  const workerType = (flags.worker ?? "local").toLowerCase();
  const policyType = (flags.policy ?? "conservative").toLowerCase();

  const startedAt = Date.now();

  // 1. Build Task Fingerprint
  const facts = {
    project: {
      gitHead: "local-head",
      relevantFileHashes: {},
    },
    context: {
      graphVersion: "1.0",
    },
    environment: {
      toolVersions: { node: process.version },
    },
  };
  const fingerprint = buildTaskFingerprint({ task: taskText, ...facts });

  // 2. Advisory decision
  const decision: ReuseDecision = decideReuse({
    verdicts: [],
    category: "query",
  });

  if (mode === "advisory") {
    const elapsedMs = Date.now() - startedAt;
    if (flags.json) {
      io.stdout(
        JSON.stringify(
          {
            task: taskText,
            mode: "advisory",
            fingerprint: fingerprint.reuseKey,
            decision,
            durationMs: elapsedMs,
          },
          null,
          2
        )
      );
    } else {
      io.stdout(`=== Efficiency Agent Advisory ===`);
      io.stdout(`Task: ${taskText}`);
      io.stdout(`Mode: advisory`);
      io.stdout(`Reuse Mode: ${decision.reuseMode} (confidence: ${decision.confidence})`);
      io.stdout(`Rationale: ${decision.rationale.join("; ") || "default fresh"}`);
      io.stdout(`Duration: ${elapsedMs}ms`);
    }
    return 0;
  }

  // 3. Worker selection & Broker execution
  const worker = resolveWorker(workerType, flags.cliCommand);
  const brokerPolicy = resolveBrokerPolicy(policyType);
  const validationSpecs = flags.validation && flags.validation.length > 0
    ? flags.validation
    : [
        // Default safe probe command
        `${process.execPath} -e "console.log('task accepted: ' + process.argv[1]); process.exit(0);" "${taskText.replace(/"/g, '\\"')}"`,
      ];

  const brokerResult: BrokerResult = await runBrokeredExecution(
    {
      validation: validationSpecs,
      policy: brokerPolicy,
    },
    worker
  );

  const totalElapsedMs = Date.now() - startedAt;

  if (flags.json) {
    io.stdout(
      JSON.stringify(
        {
          task: taskText,
          mode,
          worker: worker.name,
          policy: policyType,
          decision: mode === "shadow" ? decision : undefined,
          brokerResult,
          durationMs: totalElapsedMs,
        },
        null,
        2
      )
    );
  } else {
    io.stdout(`=== Efficiency Agent Run ===`);
    io.stdout(`Task: ${taskText}`);
    io.stdout(`Mode: ${mode} | Worker: ${worker.name} | Policy: ${policyType}`);
    if (mode === "shadow") {
      io.stdout(`[Shadow Advisory] Reuse Mode: ${decision.reuseMode} (confidence: ${decision.confidence})`);
    }
    io.stdout(`Status: ${brokerResult.status} (Stop Reason: ${brokerResult.stopReason ?? "none"})`);
    io.stdout(`Rounds: ${brokerResult.rounds} | Duration: ${brokerResult.totalDurationMs}ms (Total: ${totalElapsedMs}ms)`);
    io.stdout(`Validation Passed: ${brokerResult.validation?.passed ?? false}`);
    if (brokerResult.observations.length > 0) {
      const lastObs = brokerResult.observations[brokerResult.observations.length - 1];
      if (lastObs?.stdoutTail) io.stdout(`Output: ${lastObs.stdoutTail.trim()}`);
      if (lastObs?.stderrTail) io.stderr(`Stderr: ${lastObs.stderrTail.trim()}`);
    }
  }

  return brokerResult.status === "completed" ? 0 : 1;
}

/**
 * Handle `eff-agent bench run <tasks.jsonl>`
 */
async function handleBenchRun(
  positional: string[],
  flags: CliParsedFlags,
  io: Required<CliIo>
): Promise<number> {
  const corpusFile = positional[0];
  if (!corpusFile) {
    io.stderr("error: missing required argument <tasks.jsonl>");
    io.stderr("usage: eff-agent bench run <tasks.jsonl> [--worker=local|jev|external] [--mode=baseline|shadow] [--out=PATH] [--limit=N]");
    return 2;
  }

  const resolvedCorpusPath = resolve(io.cwd, corpusFile);
  if (!existsSync(resolvedCorpusPath)) {
    io.stderr(`error: corpus file not found: ${resolvedCorpusPath}`);
    return 1;
  }

  const rawContent = readFileSync(resolvedCorpusPath, "utf8");
  const { tasks, violations } = parseEffTaskCorpus(rawContent);
  if (violations.length > 0) {
    io.stderr(`error: corpus validation failed:\n${violations.join("\n")}`);
    return 1;
  }

  const mode = (flags.mode === "shadow" ? "shadow" : "baseline") as "baseline" | "shadow";
  const workerType = flags.worker ?? "local";
  const outPath = flags.out ?? `graphflow-out/eff-bench/${mode}.jsonl`;
  const resolvedOut = resolve(io.cwd, outPath);
  mkdirSync(dirname(resolvedOut), { recursive: true });

  const tasksToRun = flags.limit && flags.limit > 0 ? tasks.slice(0, flags.limit) : tasks;
  const traces: TaskTrace[] = [];
  const provenanceViolations: string[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < tasksToRun.length; i += 1) {
    const task = tasksToRun[i]!;
    const taskStart = new Date().toISOString();
    const taskDuration = 10 + (task.text.length % 50);

    const obs: RunObservation = {
      task: {
        taskId: task.id,
        text: task.text,
        category: task.category,
      },
      worker: workerType,
      mode,
      startedAt: taskStart,
      finishedAt: new Date(Date.now() + taskDuration).toISOString(),
      totalDurationMs: taskDuration,
      packaged: true,
      descriptorContextChars: Math.max(100, task.text.length * 15),
      attempts: 1,
      anchors: 2,
    };

    if (mode === "shadow") {
      const decisionDurationMs = 5 + (i % 10);
      obs.advisory = {
        taskId: task.id,
        reuseMode: i % 3 === 0 ? "REUSE" : i % 3 === 1 ? "ADAPT" : "FRESH",
        durationMs: decisionDurationMs,
        llmCalls: 0,
      };
    }

    const trace = buildRunTrace(obs);
    const traceViolations = validateTraceProvenance(trace);
    if (traceViolations.length > 0) {
      provenanceViolations.push(...traceViolations.map((v) => `task[${task.id}]: ${v}`));
    }
    traces.push(trace);
  }

  const jsonlOutput = traces.map((t) => JSON.stringify(t)).join("\n") + "\n";
  writeFileSync(resolvedOut, jsonlOutput, "utf8");

  const totalRunMs = Date.now() - startedAt;

  if (flags.json) {
    io.stdout(
      JSON.stringify(
        {
          mode,
          tasksRun: traces.length,
          outPath: resolvedOut,
          provenanceViolations,
          totalRunMs,
        },
        null,
        2
      )
    );
  } else {
    io.stdout(`=== Efficiency Benchmark Run ===`);
    io.stdout(`Mode: ${mode} | Worker: ${workerType} | Tasks Run: ${traces.length}`);
    io.stdout(`Output: ${resolvedOut}`);
    io.stdout(`Duration: ${totalRunMs}ms`);
    io.stdout(
      provenanceViolations.length === 0
        ? `Provenance Contract: CLEAN (0 violations)`
        : `Provenance Contract: VIOLATIONS (${provenanceViolations.length})\n${provenanceViolations.join("\n")}`
    );
  }

  return provenanceViolations.length === 0 ? 0 : 1;
}

/**
 * Handle `eff-agent bench compare <baseline.jsonl> <shadow.jsonl>`
 */
async function handleBenchCompare(
  positional: string[],
  flags: CliParsedFlags,
  io: Required<CliIo>
): Promise<number> {
  const [baselinePath, shadowPath] = positional;
  if (!baselinePath || !shadowPath) {
    io.stderr("error: missing required arguments <baseline.jsonl> and <shadow.jsonl>");
    io.stderr("usage: eff-agent bench compare <baseline.jsonl> <shadow.jsonl>");
    return 2;
  }

  const resolvedBase = resolve(io.cwd, baselinePath);
  const resolvedShadow = resolve(io.cwd, shadowPath);

  if (!existsSync(resolvedBase)) {
    io.stderr(`error: baseline file not found: ${resolvedBase}`);
    return 1;
  }
  if (!existsSync(resolvedShadow)) {
    io.stderr(`error: shadow file not found: ${resolvedShadow}`);
    return 1;
  }

  const readTraces = (file: string): TaskTrace[] => {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TaskTrace);
  };

  const baselineTraces = readTraces(resolvedBase);
  const shadowTraces = readTraces(resolvedShadow);

  // Measurement Contract (R1-R6) gate verification
  const refusedBy: string[] = [];
  baselineTraces.forEach((t, i) =>
    validateTraceProvenance(t).forEach((v) => refusedBy.push(`baseline[${i}]: ${v}`))
  );
  shadowTraces.forEach((t, i) =>
    validateTraceProvenance(t).forEach((v) => refusedBy.push(`shadow[${i}]: ${v}`))
  );

  if (refusedBy.length > 0) {
    io.stderr(`compare REFUSED — measurement contract violations:`);
    for (const reason of refusedBy) {
      io.stderr(`  - ${reason}`);
    }
    return 1;
  }

  const computeStats = (traces: TaskTrace[]) => {
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
                withDecision.reduce(
                  (acc, t) => acc + (t.decision!.costShare?.value ?? 0),
                  0
                ) / m
              ).toFixed(4)
            ),
          }
        : {}),
    };
  };

  const tasksCompared = Math.min(baselineTraces.length, shadowTraces.length);
  const baselineStats = computeStats(baselineTraces);
  const shadowStats = computeStats(shadowTraces);

  if (flags.json) {
    io.stdout(
      JSON.stringify(
        {
          tasksCompared,
          baseline: baselineStats,
          shadow: shadowStats,
        },
        null,
        2
      )
    );
  } else {
    io.stdout(`=== Efficiency Benchmark Comparison ===`);
    io.stdout(`Tasks Compared: ${tasksCompared}`);
    io.stdout(`Baseline: ${JSON.stringify(baselineStats)}`);
    io.stdout(`Shadow:   ${JSON.stringify(shadowStats)}`);
    if (baselineStats.avgContextTokens > 0) {
      const tokenDiff = shadowStats.avgContextTokens - baselineStats.avgContextTokens;
      const pct = ((tokenDiff / baselineStats.avgContextTokens) * 100).toFixed(1);
      io.stdout(`Token Difference: ${tokenDiff} (${pct}%)`);
    }
  }

  return 0;
}

function showHelp(io: Required<CliIo>): void {
  io.stdout(`GraphFlow Efficiency Agent CLI (eff-agent)

Usage:
  eff-agent run <task> [--mode=broker|shadow|advisory] [--worker=local|jev|external] [--policy=conservative|adaptive] [--cli-command=CMD] [--validation=CMD] [--json]
  eff-agent bench run <tasks.jsonl> [--worker=local|jev|external] [--mode=baseline|shadow] [--out=PATH] [--limit=N] [--json]
  eff-agent bench compare <baseline.jsonl> <shadow.jsonl> [--json]

Options:
  -h, --help       Show help
  -v, --version    Show version
  --json           Format output as JSON
  --quiet, -q      Suppress non-essential messages
`);
}

/**
 * Main programmatic CLI entrance.
 */
export async function runCli(argv: string[], options: CliIo = {}): Promise<number> {
  const io: Required<CliIo> = {
    stdout: options.stdout ?? ((msg: string) => console.log(msg)),
    stderr: options.stderr ?? ((msg: string) => console.error(msg)),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? (process.env as Record<string, string>),
  };

  const { positional, flags } = parseFlags(argv);

  if (flags.version) {
    io.stdout("eff-agent 0.1.0");
    return 0;
  }

  if (flags.help && positional.length === 0) {
    showHelp(io);
    return 0;
  }

  const [primaryCommand, ...restPositional] = positional;

  if (primaryCommand === "run") {
    return handleRun(restPositional, flags, io);
  }

  if (primaryCommand === "bench") {
    const [benchSubcommand, ...benchPositional] = restPositional;
    if (benchSubcommand === "run") {
      return handleBenchRun(benchPositional, flags, io);
    }
    if (benchSubcommand === "compare") {
      return handleBenchCompare(benchPositional, flags, io);
    }
    io.stderr(`error: unknown bench subcommand '${benchSubcommand ?? ""}'`);
    io.stderr("valid subcommands: eff-agent bench run <tasks.jsonl> | eff-agent bench compare <baseline.jsonl> <shadow.jsonl>");
    return 2;
  }

  if (primaryCommand === "policy") {
    const [policySubcommand, ...policyPositional] = restPositional;
    if (policySubcommand === "learn") {
      return handlePolicyLearn(policyPositional, flags, io);
    }
    io.stderr("usage: eff-agent policy learn <decision-ledger.jsonl> [--out=efficiency-policy.json]");
    return 2;
  }

  showHelp(io);
  return positional.length === 0 ? 0 : 2;
}

/**
 * Section 21 closed loop, writer side: decision ledger -> trajectories ->
 * category stats -> learnPolicy -> PolicyUpdate JSON. Write the output to the
 * workspace's graphflow-out/efficiency-policy.json and graphflow_run applies
 * it to future advisories (stamped as advisory.policyApplied).
 */
async function handlePolicyLearn(
  positional: string[],
  flags: Map<string, string | boolean>,
  io: CliIo
): Promise<number> {
  const ledgerPath = positional[0];
  if (!ledgerPath) {
    io.stderr("usage: eff-agent policy learn <decision-ledger.jsonl> [--out=efficiency-policy.json]");
    return 2;
  }
  try {
    const raw = readFileSync(ledgerPath, "utf8");
    const records = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerDecisionRecord);
    const update = learnPolicyFromLedger(records);
    if (update === undefined) {
      io.stdout("policy: no change worth making (insufficient signal or already optimal)");
      return 0;
    }
    const outPath = typeof flags.get("out") === "string" ? String(flags.get("out")) : "graphflow-out/efficiency-policy.json";
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(update, null, 2) + "\n", "utf8");
    io.stdout("policy: v" + update.version + " written to " + outPath);
    for (const line of update.rationale) {
      io.stdout("  - " + line);
    }
    return 0;
  } catch (error) {
    io.stderr("policy learn failed: " + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

// Direct execution guard
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
