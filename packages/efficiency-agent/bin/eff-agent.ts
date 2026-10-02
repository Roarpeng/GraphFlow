#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  armPipelineMode,
  benchArmFlags,
  BENCH_ARMS,
  closeGraphFlowClients,
  collectProjectFacts,
  compareArms,
  createDefaultSecurity,
  createExperienceStore,
  createFileKVStore,
  createPolicyLifecycle,
  createPolicyStore,
  createTaskWorkspace,
  EFF_AGENT_VERSION,
  fetchGraphFlowContext,
  FLAG_NAMES,
  graphArtifactVersion,
  invalidateCaches,
  isFlagName,
  judgeOracle,
  learnPolicyFromLedger,
  parseBenchDataset,
  parseFlagValue,
  planBenchUnits,
  prewarmGraphFlowClient,
  provenanceRefusals,
  renderReplay,
  replayProblems,
  resolveFlags,
  resolveGraphFlowServer,
  reuseExpectationOutcome,
  runEfficiencyPipeline,
  runGuards,
  runPipelineFailOpen,
  toOtlpJson,
  traceToOtelSpans,
  validateTraceProvenance,
  withVerdict,
  writeFlagsFile,
  type AgentExecutorSpec,
  type BenchArm,
  type EffFlags,
  type GraphFlowServerCommand,
  type LedgerDecisionRecord,
  type PipelineDeps,
  type PipelineMode,
  type PipelinePolicy,
  type PipelineResult,
  type RunStatus,
  type TaskTrace,
  TRACE_TASK_CATEGORIES,
  isTraceTaskCategory,
} from "../src/index.js";

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
  advisor?: string;
  out?: string;
  limit?: number;
  only?: string[];
  cliCommand?: string;
  cliArgs?: string;
  promptVia?: string;
  timeoutMs?: number;
  budgetMs?: number;
  category?: string;
  validation?: string[];
  graphflowMcp?: string;
  noGraphflow?: boolean;
  stateDir?: string;
  arm?: string;
  securityPolicy?: string;
  otelOut?: string;
  id?: string;
  approve?: boolean;
  gate?: boolean;
  json?: boolean;
  quiet?: boolean;
  help?: boolean;
  version?: boolean;
}

const VALUE_FLAGS: Record<string, keyof CliParsedFlags> = {
  "--mode": "mode",
  "--worker": "worker",
  "--policy": "policy",
  "--advisor": "advisor",
  "--out": "out",
  "--output": "out",
  "--limit": "limit",
  "--only": "only",
  "--cli-command": "cliCommand",
  "--cli-args": "cliArgs",
  "--prompt-via": "promptVia",
  "--timeout-ms": "timeoutMs",
  "--budget-ms": "budgetMs",
  "--category": "category",
  "--validation": "validation",
  "--graphflow-mcp": "graphflowMcp",
  "--state-dir": "stateDir",
  "--arm": "arm",
  "--security-policy": "securityPolicy",
  "--otel-out": "otelOut",
  "--id": "id",
};
const NUMBER_FLAGS = new Set<keyof CliParsedFlags>(["limit", "timeoutMs", "budgetMs"]);

/**
 * Parse flag arguments from an argv slice. Value flags accept `--flag=value`
 * and `--flag value`; a following token starting with `--` is never consumed.
 */
export function parseFlags(argv: string[]): { positional: string[]; flags: CliParsedFlags } {
  const positional: string[] = [];
  const flags: CliParsedFlags = {};
  const assign = (key: keyof CliParsedFlags, value: string): void => {
    if (key === "validation") {
      flags.validation = [...(flags.validation ?? []), value];
    } else if (key === "only") {
      flags.only = [...(flags.only ?? []), ...value.split(",").map((s) => s.trim()).filter(Boolean)];
    } else if (NUMBER_FLAGS.has(key)) {
      (flags as Record<string, unknown>)[key] = Number(value);
    } else {
      (flags as Record<string, unknown>)[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--quiet" || arg === "-q") flags.quiet = true;
    else if (arg === "--no-graphflow") flags.noGraphflow = true;
    else if (arg === "--approve") flags.approve = true;
    else if (arg === "--gate") flags.gate = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      const key = VALUE_FLAGS[name];
      if (!key) continue;
      if (eq >= 0) assign(key, arg.slice(eq + 1));
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) assign(key, argv[++i]!);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function tokenize(spec: string): string[] {
  return Array.from(spec.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (m) => m[1] ?? m[2] ?? m[3] ?? "");
}

// ───────────── shared validation of §25 flags ─────────────

const RUN_MODES = ["advisory", "shadow", "broker"] as const;
const POLICIES = ["conservative", "adaptive"] as const;
const WORKERS = ["local", "external", "baseline", "jev"] as const;
const ADVISORS = ["efficiency", "none"] as const;
const DEFAULT_EXECUTOR_TIMEOUT_MS = 15 * 60_000;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | string | undefined {
  if (value === undefined) return undefined;
  const norm = value.toLowerCase();
  return (allowed as readonly string[]).includes(norm) ? (norm as T) : `error: unknown ${flag} '${value}' (expected ${allowed.join("|")})`;
}

function isError(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("error: ");
}

function buildExecutor(flags: CliParsedFlags): AgentExecutorSpec | string | undefined {
  if (!flags.cliCommand) return undefined;
  const promptVia = flags.promptVia === undefined ? "stdin" : flags.promptVia.toLowerCase();
  if (promptVia !== "stdin" && promptVia !== "arg") return `error: unknown --prompt-via '${flags.promptVia}' (expected stdin|arg)`;
  const args = flags.cliArgs ? tokenize(flags.cliArgs) : [];
  if (promptVia === "arg" && !args.includes("{prompt}")) args.push("{prompt}");
  const timeoutMs = flags.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return "error: --timeout-ms must be a positive number";
  return { command: flags.cliCommand, args, promptVia, timeoutMs };
}

interface HostOptions {
  stateDir: string;
  contextRoot: string;
  flags: CliParsedFlags;
  env: Record<string, string>;
  traceFile?: string;
}

function resolveServer(flags: CliParsedFlags, env: Record<string, string>): GraphFlowServerCommand | undefined {
  if (flags.noGraphflow) return undefined;
  return resolveGraphFlowServer(flags.graphflowMcp, env);
}

function securityPolicyPath(stateDir: string, flags: CliParsedFlags, cwd: string): string {
  return flags.securityPolicy ? resolve(cwd, flags.securityPolicy) : join(stateDir, "security-policy.json");
}

/** Real host adapters: git/file facts, GraphFlow over MCP, file-backed stores, security gate. */
function createHostDeps(options: HostOptions & { security: ReturnType<typeof createDefaultSecurity> }): PipelineDeps {
  mkdirSync(options.stateDir, { recursive: true });
  const server = resolveServer(options.flags, options.env);
  return {
    security: options.security,
    collectFacts: (root, task) => collectProjectFacts(root, task),
    graphVersion: () => graphArtifactVersion(options.contextRoot),
    ...(server
      ? {
          fetchContext: (task: string) => fetchGraphFlowContext({ task, rootDir: options.contextRoot, server }),
          prewarmContext: () => prewarmGraphFlowClient({ rootDir: options.contextRoot, server }),
        }
      : {}),
    cacheStore: createFileKVStore(join(options.stateDir, "cache.json")),
    toolStore: createFileKVStore(join(options.stateDir, "tools.json")),
    policyKv: createFileKVStore(join(options.stateDir, "policy.json")),
    experience: createExperienceStore(join(options.stateDir, "history.jsonl")),
    ...(options.traceFile
      ? {
          traceSink: (trace: TaskTrace) => {
            mkdirSync(dirname(options.traceFile!), { recursive: true });
            appendFileSync(options.traceFile!, JSON.stringify(trace) + "\n", "utf8");
          },
        }
      : {}),
  };
}

function exitCodeFor(status: RunStatus): number {
  switch (status) {
    case "completed":
    case "reused":
    case "validation-only":
    case "advisory-only":
      return 0;
    case "not-executed":
      return 3;
    case "unverified":
      return 4;
    case "blocked":
      return 5;
    case "violation":
      return 6;
    default:
      return 1;
  }
}

function flagsFile(stateDir: string): string {
  return join(stateDir, "flags.json");
}

function loadRunFlags(stateDir: string, io: Required<CliIo>): EffFlags {
  const resolved = resolveFlags({ file: flagsFile(stateDir), env: io.env });
  for (const warning of resolved.warnings) io.stderr(`warning: ${warning}`);
  return resolved.flags;
}

function printRun(result: PipelineResult, io: Required<CliIo>): void {
  // Legacy Windows consoles garble non-ASCII punctuation.
  const out = (line: string) => io.stdout(line.replace(/→/g, "->").replace(/[—–]/g, "-"));
  const fp = result.fingerprint;
  out(`=== Efficiency Agent Run (section 27 pipeline) ===`);
  out(`Task: ${result.task}`);
  out(`Mode: ${result.mode} | Policy: ${result.policy} | Category: ${result.category}`);
  if (result.modeCapReason) out(`   Requested ${result.requestedMode}, capped to ${result.mode}: ${result.modeCapReason}`);
  out(`Decision: ${result.record.decisionId} | policy v${result.record.policyVersion} | ${result.record.securityPolicyVersion ?? "security n/a"} | cache ${result.record.cacheNamespace}`);
  out(`1. Fingerprint: ${fp.reuseKey}`);
  out(`2. Project Twin: ${result.twin.project} - ${result.twin.fileCount} files, ${result.twin.modules.length} modules; ` +
    `tests=[${result.twin.tests.join(", ")}] build=[${result.twin.build.join(", ")}]`);
  if (result.twin.relevantFiles.length > 0) out(`   Relevant files: ${result.twin.relevantFiles.join(", ")}`);
  out(`3. Experience: ${result.experience.similar.length} similar past task(s)` +
    (result.experience.similar[0] ? ` (top ${result.experience.similar[0].similarity}: "${result.experience.similar[0].task}" -> ${result.experience.similar[0].status})` : "") +
    `; GraphFlow dialogue hits ${result.experience.dialogueHits}`);
  out(`4. Context: ${result.context.source}; anchors ${result.context.anchors.length}` +
    (result.context.compressedTokens !== undefined ? `; ~${result.context.compressedTokens} compressed tokens` : "") +
    (result.context.error ? ` (${result.context.error})` : ""));
  out(`5. Reuse Gate: ${result.rawDecision.reuseMode} -> applied ${result.appliedDecision.reuseMode} (confidence ${result.appliedDecision.confidence})`);
  for (const line of result.appliedDecision.rationale) out(`   - ${line}`);
  out(`   Security: ${result.security.verdict} (${result.security.risk})` +
    (result.security.reasons.length > 0 ? ` - ${result.security.reasons.slice(0, 3).join("; ")}` : ""));
  out(`6. Tool Selection: ${result.tools.selected.map((t) => t.name).join(", ") || "none"}` +
    (result.tools.rejected.length > 0 ? ` | unserved: ${result.tools.rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}` : ""));
  out(`7. Model Routing: tier ${result.contract.worker.modelTier}, ${result.contract.worker.executionMode}, max rounds ${result.harness.maxRounds}; ` +
    `harness ${result.harness.complexity}, budget ${result.harness.budgetMs}ms`);
  if (result.costChoice) {
    out(`8. Cost Optimizer: chose ${result.costChoice.chosen ?? "nothing"}` +
      (result.costChoice.rejected.length > 0 ? `; rejected ${result.costChoice.rejected.map((r) => `${r.id} (${r.reason})`).join(", ")}` : ""));
  } else {
    out(`8. Cost Optimizer: no executable candidate`);
  }
  if (result.execution) {
    out(`9. Execution: ${result.execution.rounds} round(s), ${result.execution.durationMs}ms, ${result.execution.agentInvocations} agent invocation(s)`);
    for (const check of result.execution.validation) out(`   ${check.passed ? "PASS" : "FAIL"} ${check.name}`);
    if (result.execution.output) out(`   Output: ${result.execution.output.trim().slice(-1_500)}`);
  } else {
    out(`9. Execution: none`);
  }
  if (result.writeAudit) {
    out(`   Write audit: ${result.writeAudit.verdict}; ${result.writeAudit.newlyChanged.length} path(s) changed` +
      (result.writeAudit.newlyChanged.length > 0 ? ` (${result.writeAudit.newlyChanged.slice(0, 5).join(", ")})` : ""));
  }
  out(`10. Experience Update: policy v${result.policyVersion ?? 0}; ${result.reflections.length} reflection finding(s)`);
  if (result.contractViolations.length > 0) out(`Contract violations: ${result.contractViolations.join("; ")}`);
  if (result.failOpen) out(`FAIL-OPEN: ${result.failOpen.reason} (ran on the native worker path)`);
  for (const warning of result.warnings) out(`Warning: ${warning}`);
  out(`Status: ${result.status} - ${result.statusReason}`);
  out(`Duration: ${result.durationMs}ms`);
}

/**
 * `eff-agent run <task>` — the §27 pipeline end to end. Nothing is reported
 * as done unless an executor ran and validation passed.
 */
async function handleRun(positional: string[], flags: CliParsedFlags, io: Required<CliIo>): Promise<number> {
  const taskText = positional[0];
  if (!taskText) {
    io.stderr("error: missing required argument <task>");
    io.stderr("usage: eff-agent run <task> [--mode=broker|shadow|advisory] [--policy=conservative|adaptive] [--worker=local|external --cli-command=CMD] [--validation=CMD]");
    return 2;
  }
  const mode = oneOf(flags.mode ?? "broker", RUN_MODES, "--mode");
  const policy = oneOf(flags.policy ?? "conservative", POLICIES, "--policy");
  const worker = oneOf(flags.worker, WORKERS, "--worker");
  const advisor = oneOf(flags.advisor ?? "efficiency", ADVISORS, "--advisor");
  const executor = buildExecutor(flags);
  for (const value of [mode, policy, worker, advisor, executor]) {
    if (isError(value)) {
      io.stderr(value);
      return 2;
    }
  }
  if (worker === "baseline") {
    io.stderr("error: --worker baseline selects a benchmark arm; use `eff-agent bench run --worker baseline` (or `run --advisor none`)");
    return 2;
  }
  if (worker === "jev") {
    io.stderr("error: the TypeSafe Jev worker judges validation specs but cannot perform a task; use --worker external --cli-command <agent CLI>");
    return 2;
  }
  if (worker === "external" && !executor) {
    io.stderr("error: --worker external needs --cli-command <agent CLI> (e.g. claude, codex, gemini)");
    return 2;
  }
  if (worker === "local" && executor) {
    io.stderr("error: --worker local runs validation commands only; drop --cli-command or use --worker external");
    return 2;
  }
  if (flags.category !== undefined && !isTraceTaskCategory(flags.category)) {
    io.stderr(`error: --category must be one of ${TRACE_TASK_CATEGORIES.join(", ")}`);
    return 2;
  }

  const root = io.cwd;
  const stateDir = flags.stateDir ? resolve(root, flags.stateDir) : join(root, "graphflow-out", "eff-agent");
  const traceFile = flags.out ? resolve(root, flags.out) : join(stateDir, "traces.jsonl");
  const pipelineMode: PipelineMode = advisor === "none" ? "baseline" : (mode as PipelineMode);
  const effFlags = loadRunFlags(stateDir, io);
  const security = createDefaultSecurity({ policyFile: securityPolicyPath(stateDir, flags, root) });
  if (security.loadError) io.stderr(`warning: security policy fail-closed (STRICT): ${security.loadError}`);
  const result = await runPipelineFailOpen(
    {
      task: taskText,
      root,
      mode: pipelineMode,
      policy: policy as PipelinePolicy,
      ...(flags.category ? { category: flags.category } : {}),
      validation: flags.validation ?? [],
      ...(executor ? { executor: executor as AgentExecutorSpec } : {}),
      ...(flags.budgetMs ? { budgetMs: flags.budgetMs } : {}),
      flags: effFlags,
      ...(flags.approve ? { approved: true } : {}),
    },
    createHostDeps({ stateDir, contextRoot: root, flags, env: io.env, traceFile, security })
  );

  if (flags.json) io.stdout(JSON.stringify(result, null, 2));
  else printRun(result, io);
  return exitCodeFor(result.status);
}

// ───────────── bench ─────────────

function resolveBenchArm(flags: CliParsedFlags): BenchArm | string {
  if (flags.arm !== undefined) {
    const arm = oneOf(flags.arm, BENCH_ARMS, "--arm");
    return arm as BenchArm | string;
  }
  const worker = oneOf(flags.worker, WORKERS, "--worker");
  const advisor = oneOf(flags.advisor, ADVISORS, "--advisor");
  const policy = oneOf(flags.policy ?? "conservative", POLICIES, "--policy");
  const mode = oneOf(flags.mode, ["baseline", "shadow", "broker"] as const, "--mode");
  for (const value of [worker, advisor, policy, mode]) if (isError(value)) return value;
  if (worker === "local" || worker === "jev") {
    return `error: bench arms need an executor; --worker ${worker} cannot perform tasks (use --worker baseline|external with --cli-command)`;
  }
  if (worker === "baseline" || advisor === "none" || mode === "baseline") {
    if (mode === "shadow" || mode === "broker") return `error: --worker baseline / --advisor none conflicts with --mode ${mode}`;
    return "baseline";
  }
  if (mode === "shadow") return "shadow";
  if (mode === "broker") return policy as BenchArm;
  return "error: choose an arm: --arm baseline|graphflow|shadow|conservative|adaptive (or --worker baseline | --mode shadow | --mode broker --policy P)";
}

function gitTopLevel(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * `eff-agent bench run <tasks.jsonl>` — real P0 runner: per-task worktree,
 * real executor, oracle-judged outcome. Refuses to run without an executor.
 * Accepts Golden-Core, Golden-Extended and Long-Horizon files; a long-horizon
 * session runs its steps in order in one worktree.
 */
async function handleBenchRun(positional: string[], flags: CliParsedFlags, io: Required<CliIo>): Promise<number> {
  const corpusFile = positional[0];
  if (!corpusFile) {
    io.stderr("error: missing required argument <tasks.jsonl>");
    io.stderr("usage: eff-agent bench run <tasks.jsonl> (--worker baseline | --advisor efficiency --mode shadow | --mode broker --policy conservative) --cli-command CMD [--output PATH] [--limit N] [--only ids|cohorts|families|sessions|templates]");
    return 2;
  }
  const resolvedCorpusPath = resolve(io.cwd, corpusFile);
  if (!existsSync(resolvedCorpusPath)) {
    io.stderr(`error: corpus file not found: ${resolvedCorpusPath}`);
    return 1;
  }
  const dataset = parseBenchDataset(readFileSync(resolvedCorpusPath, "utf8"));
  if (dataset.violations.length > 0) {
    io.stderr(`error: corpus validation failed (${dataset.kind}):\n${dataset.violations.join("\n")}`);
    return 1;
  }
  const arm = resolveBenchArm(flags);
  if (isError(arm)) {
    io.stderr(arm);
    return 2;
  }
  const executor = buildExecutor(flags);
  if (isError(executor)) {
    io.stderr(executor);
    return 2;
  }
  if (!executor) {
    io.stderr("error: bench run needs a real executor (--cli-command <agent CLI>); it never synthesises durations or outcomes");
    return 2;
  }
  const repoRoot = gitTopLevel(io.cwd);
  if (!repoRoot) {
    io.stderr("error: bench run must start inside a git repository (tasks run in isolated worktrees)");
    return 2;
  }

  const outPath = resolve(io.cwd, flags.out ?? `graphflow-out/eff-bench/${arm}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, "", "utf8");
  const stateDir = flags.stateDir
    ? resolve(io.cwd, flags.stateDir)
    : join(repoRoot, "graphflow-out", "eff-agent", `bench-${arm}`);
  const security = createDefaultSecurity({ policyFile: securityPolicyPath(stateDir, flags, io.cwd) });
  if (security.loadError) io.stderr(`warning: security policy fail-closed (STRICT): ${security.loadError}`);
  const deps = createHostDeps({ stateDir, contextRoot: repoRoot, flags, env: io.env, security });
  const { mode, policy } = armPipelineMode(arm);
  const armFlags = benchArmFlags(arm);
  const units = planBenchUnits(dataset, flags.limit, flags.only);
  const stepCount = units.reduce((n, unit) => n + unit.steps.length, 0);
  const errors: string[] = [];
  const provenanceViolations: string[] = [];
  const reuseVerdicts: Record<string, number> = {};
  let judged = 0;
  let passed = 0;
  const startedAt = Date.now();

  for (const unit of units) {
    let workspace: ReturnType<typeof createTaskWorkspace> | undefined;
    try {
      workspace = createTaskWorkspace(repoRoot, unit.revision);
    } catch (error) {
      errors.push(`unit[${unit.id}]: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let aborted: string | undefined;
    for (const step of unit.steps) {
      const plan = { task: step.task };
      if (aborted) {
        errors.push(`task[${plan.task.id}]: skipped, ${aborted} failed to run (session state is incomplete)`);
        continue;
      }
      try {
        const result = await runEfficiencyPipeline(
          {
            task: plan.task.text,
            root: workspace.dir,
            mode,
            policy,
            category: plan.task.category,
            validation: flags.validation ?? [],
            executor,
            ...(flags.budgetMs ? { budgetMs: flags.budgetMs } : {}),
            flags: armFlags,
            ...(flags.approve ? { approved: true } : {}),
          },
          deps
        );
        if (!result.trace) throw new Error(`no trace produced (status ${result.status})`);
        const verdict = await judgeOracle({
          oracle: plan.task.oracle,
          output: result.execution?.output ?? "",
          cwd: workspace.dir,
        });
        const regression = await runGuards(plan.task.guards, workspace.dir);
        const trace = withVerdict(result.trace, verdict, plan.task.id, { arm, ...(regression ? { regression } : {}) });
        provenanceViolations.push(...validateTraceProvenance(trace).map((v) => `task[${plan.task.id}]: ${v}`));
        appendFileSync(outPath, JSON.stringify(trace) + "\n", "utf8");
        if (verdict.judged) {
          judged += 1;
          if (verdict.passed) passed += 1;
        }
        const reuse = step.expect ? reuseExpectationOutcome(step.expect, trace) : undefined;
        if (reuse) reuseVerdicts[reuse.verdict] = (reuseVerdicts[reuse.verdict] ?? 0) + 1;
        if (!flags.quiet && !flags.json) {
          io.stdout(
            `[${plan.task.id}] ${result.status} | oracle ${verdict.judged ? (verdict.passed ? "PASS" : "FAIL") : "unjudged"}` +
              (regression ? ` | guards ${regression.passed ? "PASS" : "FAIL"}` : "") +
              (reuse ? ` | reuse expected ${reuse.expected} observed ${reuse.observed ?? "n/a"} (${reuse.verdict})` : "") +
              ` | ${result.durationMs}ms`
          );
        }
      } catch (error) {
        errors.push(`task[${plan.task.id}]: ${error instanceof Error ? error.message : String(error)}`);
        if (unit.sessionId) aborted = plan.task.id;
      }
    }
    workspace.dispose();
  }

  const summary = {
    arm,
    dataset: dataset.kind,
    units: units.length,
    tasksRun: stepCount - errors.length,
    judged,
    passed,
    successRate: judged > 0 ? Number((passed / judged).toFixed(3)) : null,
    ...(dataset.kind === "long-horizon" ? { reuseVerdicts } : {}),
    outPath,
    errors,
    provenanceViolations,
    totalRunMs: Date.now() - startedAt,
  };
  if (flags.json) {
    io.stdout(JSON.stringify(summary, null, 2));
  } else {
    io.stdout(`=== Efficiency Benchmark Run ===`);
    io.stdout(`Arm: ${arm} | Dataset: ${dataset.kind} | Executor: ${executor.command} | Tasks Run: ${summary.tasksRun}/${stepCount}`);
    io.stdout(`Judged: ${judged} | Passed: ${passed} | Success Rate: ${summary.successRate ?? "n/a (nothing judged)"}`);
    if (dataset.kind === "long-horizon") {
      io.stdout(`Reuse expectations: ${Object.entries(reuseVerdicts).map(([k, v]) => `${k}=${v}`).join(" ") || "none observed"}`);
    }
    io.stdout(`Output: ${outPath}`);
    io.stdout(`Duration: ${summary.totalRunMs}ms`);
    for (const error of errors) io.stderr(`error: ${error}`);
    io.stdout(
      provenanceViolations.length === 0
        ? `Provenance Contract: CLEAN (0 violations)`
        : `Provenance Contract: VIOLATIONS (${provenanceViolations.length})\n${provenanceViolations.join("\n")}`
    );
  }
  return errors.length === 0 && provenanceViolations.length === 0 ? 0 : 1;
}

function readTraces(file: string): TaskTrace[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TaskTrace);
}

/**
 * `eff-agent bench compare <baseline.jsonl> <candidate.jsonl>` — paired on
 * task id; success counts oracle-judged traces only. Reports the §18 deltas,
 * the paired regression rate, Net Saving and the §28 acceptance gates
 * (`--gate` turns a failed gate into exit code 1).
 */
async function handleBenchCompare(positional: string[], flags: CliParsedFlags, io: Required<CliIo>): Promise<number> {
  const [baselinePath, candidatePath] = positional;
  if (!baselinePath || !candidatePath) {
    io.stderr("error: missing required arguments <baseline.jsonl> and <candidate.jsonl>");
    io.stderr("usage: eff-agent bench compare <baseline.jsonl> <candidate.jsonl> [--json] [--gate]");
    return 2;
  }
  const resolvedBase = resolve(io.cwd, baselinePath);
  const resolvedCandidate = resolve(io.cwd, candidatePath);
  if (!existsSync(resolvedBase)) {
    io.stderr(`error: baseline file not found: ${resolvedBase}`);
    return 1;
  }
  if (!existsSync(resolvedCandidate)) {
    io.stderr(`error: candidate file not found: ${resolvedCandidate}`);
    return 1;
  }
  const baselineTraces = readTraces(resolvedBase);
  const candidateTraces = readTraces(resolvedCandidate);

  const refusedBy = [...provenanceRefusals("baseline", baselineTraces), ...provenanceRefusals("candidate", candidateTraces)];
  if (refusedBy.length > 0) {
    io.stderr(`compare REFUSED - measurement contract violations:`);
    for (const reason of refusedBy) io.stderr(`  - ${reason}`);
    return 1;
  }

  const report = compareArms(baselineTraces, candidateTraces);
  const failedGates = report.gates.filter((g) => g.passed === false);
  if (flags.json) {
    io.stdout(JSON.stringify(report, null, 2));
  } else {
    const b = report.baseline;
    const c = report.candidate;
    io.stdout(`=== Efficiency Benchmark Comparison ===`);
    io.stdout(`Tasks Compared: ${report.tasksCompared} (paired by task id)`);
    io.stdout(`Baseline:  ${JSON.stringify(b)}`);
    io.stdout(`Candidate: ${JSON.stringify(c)}`);
    if (b.successRate !== null && c.successRate !== null) {
      io.stdout(`Success Rate (judged only): ${b.successRate} -> ${c.successRate}`);
    } else {
      io.stdout(`Success Rate: n/a - no oracle-judged traces on ${b.successRate === null ? "baseline" : "candidate"} side`);
    }
    io.stdout(`Fidelity: ${b.fidelity ?? "n/a"} -> ${c.fidelity ?? "n/a"}`);
    if (b.latencyMs.avg && c.latencyMs.avg !== null) {
      const pct = (((c.latencyMs.avg - b.latencyMs.avg) / b.latencyMs.avg) * 100).toFixed(1);
      io.stdout(`Avg Duration: ${b.latencyMs.avg}ms -> ${c.latencyMs.avg}ms (${pct}%); P95 ${b.latencyMs.p95}ms -> ${c.latencyMs.p95}ms`);
    }
    if (b.avgContextTokens > 0) {
      const tokenDiff = report.delta.avgContextTokens;
      const pct = ((tokenDiff / b.avgContextTokens) * 100).toFixed(1);
      io.stdout(`Token Difference: ${tokenDiff} (${pct}%) [${c.contextTokensProvenance}]`);
    }
    io.stdout(`LLM calls: ${b.totalLlmCalls} -> ${c.totalLlmCalls} [${c.llmCallsProvenance}] | tool calls: ${b.totalToolCalls} -> ${c.totalToolCalls} | rounds: ${b.avgRounds} -> ${c.avgRounds}`);
    io.stdout(`Cache hit rate: ${b.cacheHitRate} -> ${c.cacheHitRate} | reuse rate: ${b.reuseRate} -> ${c.reuseRate}`);
    io.stdout(`Regression rate (paired): ${report.regressionRate ?? "n/a"}${report.regressions.length > 0 ? ` [${report.regressions.join(", ")}]` : ""}` +
      ` | guard failures: ${b.guardFailureRate ?? "n/a"} -> ${c.guardFailureRate ?? "n/a"}`);
    io.stdout(`Net Saving: ${report.netSaving.ms}ms${report.netSaving.pct !== null ? ` (${report.netSaving.pct}%)` : ""} (wall-clock, measured; decision cost included)`);
    io.stdout(`Acceptance gates (section 28):`);
    for (const gate of report.gates) {
      io.stdout(`  ${gate.passed === null ? "N/A " : gate.passed ? "PASS" : "FAIL"} ${gate.name} - ${gate.detail}`);
    }
  }
  return flags.gate && failedGates.length > 0 ? 1 : 0;
}

// ───────────── operations: flags / cache / policy / trace ─────────────

function opsStateDir(flags: CliParsedFlags, io: Required<CliIo>): string {
  return flags.stateDir ? resolve(io.cwd, flags.stateDir) : join(io.cwd, "graphflow-out", "eff-agent");
}

/** `eff-agent flags [get]` / `eff-agent flags set NAME=0|1 ...` / `eff-agent flags rollback`. */
function handleFlags(positional: string[], flags: CliParsedFlags, io: Required<CliIo>): number {
  const stateDir = opsStateDir(flags, io);
  const file = flagsFile(stateDir);
  const [sub = "get", ...rest] = positional;
  if (sub === "set" || sub === "rollback") {
    const updates: Partial<EffFlags> = {};
    if (sub === "rollback") {
      // One switch back to the native worker path (spec §24).
      updates.EFF_AGENT_ENABLED = false;
      updates.EFF_SHADOW_MODE = true;
    }
    for (const pair of rest) {
      const [name = "", raw = ""] = pair.split("=");
      const value = parseFlagValue(raw);
      if (!isFlagName(name) || value === undefined) {
        io.stderr(`error: expected NAME=0|1 with NAME one of ${FLAG_NAMES.join(", ")}; got '${pair}'`);
        return 2;
      }
      updates[name] = value;
    }
    if (Object.keys(updates).length === 0) {
      io.stderr("usage: eff-agent flags set NAME=0|1 [NAME=0|1 ...]");
      return 2;
    }
    writeFlagsFile(file, updates);
  } else if (sub !== "get") {
    io.stderr("usage: eff-agent flags [get] | flags set NAME=0|1 ... | flags rollback");
    return 2;
  }
  const resolved = resolveFlags({ file, env: io.env });
  if (flags.json) {
    io.stdout(JSON.stringify({ file, ...resolved }, null, 2));
  } else {
    io.stdout(`Flags (${file}; precedence default < file < env):`);
    for (const name of FLAG_NAMES) io.stdout(`  ${name}=${resolved.flags[name] ? 1 : 0}  [${resolved.sources[name]}]`);
    for (const warning of resolved.warnings) io.stdout(`  warning: ${warning}`);
  }
  return 0;
}

/** `eff-agent cache invalidate` — bump the namespace generation; old entries become unreachable. */
function handleCache(positional: string[], flags: CliParsedFlags, io: Required<CliIo>): number {
  if (positional[0] !== "invalidate") {
    io.stderr("usage: eff-agent cache invalidate [--state-dir DIR]");
    return 2;
  }
  const stateDir = opsStateDir(flags, io);
  mkdirSync(stateDir, { recursive: true });
  const { previous, current } = invalidateCaches(createFileKVStore(join(stateDir, "cache.json")));
  io.stdout(flags.json ? JSON.stringify({ previous, current }) : `cache namespace ${previous} -> ${current} (all earlier entries invalidated)`);
  return 0;
}

/** `eff-agent policy status|rollback` over the learned policy store and its lifecycle. */
function handlePolicyOps(sub: string, flags: CliParsedFlags, io: Required<CliIo>): number {
  const stateDir = opsStateDir(flags, io);
  mkdirSync(stateDir, { recursive: true });
  const kv = createFileKVStore(join(stateDir, "policy.json"));
  const lifecycle = createPolicyLifecycle(kv);
  if (sub === "rollback") {
    const before = createPolicyStore(kv).current()?.version ?? 0;
    const restored = lifecycle.rollback();
    io.stdout(`policy rollback: v${before} -> ${restored ? `v${restored.version}` : "none (deterministic defaults)"}`);
    return 0;
  }
  const status = {
    production: lifecycle.production() ?? null,
    staged: lifecycle.staged() ?? null,
    antiPatterns: lifecycle.antiPatterns(),
  };
  if (flags.json) io.stdout(JSON.stringify(status, null, 2));
  else {
    io.stdout(`Production policy: ${status.production ? `v${status.production.version}` : "none (deterministic defaults)"}`);
    io.stdout(`Staged: ${status.staged ? `v${status.staged.update.version} in ${status.staged.stage} ${JSON.stringify(status.staged.evidence)}` : "none"}`);
    io.stdout(`Anti-patterns: ${status.antiPatterns.length > 0 ? status.antiPatterns.join("; ") : "none"}`);
  }
  return 0;
}

/** `eff-agent trace replay <traces.jsonl> [--id ID] [--otel-out FILE]` — rebuild the decision path. */
function handleTrace(positional: string[], flags: CliParsedFlags, io: Required<CliIo>): number {
  const [sub, file] = positional;
  if (sub !== "replay" || !file) {
    io.stderr("usage: eff-agent trace replay <traces.jsonl> [--id TRACE_OR_TASK_ID] [--otel-out spans.json]");
    return 2;
  }
  const path = resolve(io.cwd, file);
  if (!existsSync(path)) {
    io.stderr(`error: trace file not found: ${path}`);
    return 1;
  }
  let traces = readTraces(path);
  if (flags.id) traces = traces.filter((t) => t.traceId === flags.id || t.task.taskId === flags.id || t.record?.decisionId === flags.id);
  if (traces.length === 0) {
    io.stderr("error: no matching traces");
    return 1;
  }
  let unreplayable = 0;
  for (const trace of traces) {
    const problems = replayProblems(trace);
    if (problems.length > 0) unreplayable += 1;
    if (!flags.json) {
      for (const line of renderReplay(trace)) io.stdout(line);
      io.stdout(problems.length === 0 ? "Replay: COMPLETE" : `Replay: INCOMPLETE - ${problems.join("; ")}`);
      io.stdout("");
    }
  }
  if (flags.otelOut) {
    const out = resolve(io.cwd, flags.otelOut);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(toOtlpJson(traces.flatMap((t) => traceToOtelSpans(t))), null, 2) + "\n", "utf8");
    if (!flags.json) io.stdout(`OTLP JSON written to ${out}`);
  }
  if (flags.json) io.stdout(JSON.stringify({ traces: traces.length, replayable: traces.length - unreplayable }, null, 2));
  else io.stdout(`Replayable: ${traces.length - unreplayable}/${traces.length}`);
  return unreplayable === 0 ? 0 : 1;
}

function showHelp(io: Required<CliIo>): void {
  io.stdout(`GraphFlow Efficiency Agent CLI (eff-agent)

Usage:
  eff-agent run <task> [--mode broker|shadow|advisory] [--policy conservative|adaptive]
                       [--worker local|external] [--cli-command CMD [--cli-args "ARGS"] [--prompt-via stdin|arg]]
                       [--validation CMD]... [--category C] [--budget-ms N] [--timeout-ms N]
                       [--advisor efficiency|none] [--graphflow-mcp "CMD ARGS" | --no-graphflow]
                       [--output traces.jsonl] [--state-dir DIR] [--security-policy FILE] [--approve] [--json]
  eff-agent bench run <tasks.jsonl> --cli-command CMD [--cli-args "ARGS"]
                       (--arm baseline|graphflow|shadow|conservative|adaptive
                        | --worker baseline | --mode shadow | --mode broker --policy conservative|adaptive)
                       [--output runs/ARM.jsonl] [--limit N] [--only id,cohort] [--validation CMD]...
                       (golden-v1, golden-extended-v1 or long-horizon-v1; --only also takes
                        a family, session id or template; sessions run their steps in one worktree)
  eff-agent bench compare <baseline.jsonl> <candidate.jsonl> [--json] [--gate]
  eff-agent flags [get] | flags set NAME=0|1 ... | flags rollback
  eff-agent cache invalidate
  eff-agent policy status | policy rollback | policy learn <decision-ledger.jsonl> [--output FILE]
  eff-agent trace replay <traces.jsonl> [--id ID] [--otel-out spans.json]

Feature flags (spec section 22): defaults < <state-dir>/flags.json < environment. With
EFF_AGENT_ENABLED=0 or EFF_SHADOW_MODE=1 (the defaults) broker runs are capped to shadow;
\`eff-agent flags rollback\` restores that state in one switch.

Run status -> exit code: completed/reused/validation-only/advisory-only 0, failed/budget-exhausted 1,
usage error 2, not-executed (no executor, no validation) 3, unverified (executed, nothing validated) 4,
blocked by the security policy 5, violation (unpermitted workspace writes) 6.

Options:
  -h, --help       Show help
  -v, --version    Show version
  --json           Format output as JSON
  --quiet, -q      Suppress per-task progress lines
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
    io.stdout(`eff-agent ${EFF_AGENT_VERSION}`);
    return 0;
  }
  if (flags.help && positional.length === 0) {
    showHelp(io);
    return 0;
  }

  const [primaryCommand, ...restPositional] = positional;
  if (primaryCommand === "run") return handleRun(restPositional, flags, io);

  if (primaryCommand === "bench") {
    const [benchSubcommand, ...benchPositional] = restPositional;
    if (benchSubcommand === "run") return handleBenchRun(benchPositional, flags, io);
    if (benchSubcommand === "compare") return handleBenchCompare(benchPositional, flags, io);
    io.stderr(`error: unknown bench subcommand '${benchSubcommand ?? ""}'`);
    io.stderr("valid subcommands: eff-agent bench run <tasks.jsonl> | eff-agent bench compare <baseline.jsonl> <candidate.jsonl>");
    return 2;
  }

  if (primaryCommand === "policy") {
    const [policySubcommand, ...policyPositional] = restPositional;
    if (policySubcommand === "learn") return handlePolicyLearn(policyPositional, flags, io);
    if (policySubcommand === "status" || policySubcommand === "rollback") return handlePolicyOps(policySubcommand, flags, io);
    io.stderr("usage: eff-agent policy status | policy rollback | policy learn <decision-ledger.jsonl> [--output efficiency-policy.json]");
    return 2;
  }
  if (primaryCommand === "flags") return handleFlags(restPositional, flags, io);
  if (primaryCommand === "cache") return handleCache(restPositional, flags, io);
  if (primaryCommand === "trace") return handleTrace(restPositional, flags, io);

  showHelp(io);
  return positional.length === 0 ? 0 : 2;
}

/**
 * Section 21 closed loop, writer side: decision ledger -> trajectories ->
 * category stats -> learnPolicy -> PolicyUpdate JSON. Write the output to the
 * workspace's graphflow-out/efficiency-policy.json and graphflow_run applies
 * it to future advisories (stamped as advisory.policyApplied).
 */
async function handlePolicyLearn(positional: string[], flags: CliParsedFlags, io: Required<CliIo>): Promise<number> {
  const ledgerPath = positional[0];
  if (!ledgerPath) {
    io.stderr("usage: eff-agent policy learn <decision-ledger.jsonl> [--output efficiency-policy.json]");
    return 2;
  }
  try {
    const records = readFileSync(resolve(io.cwd, ledgerPath), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerDecisionRecord);
    const update = learnPolicyFromLedger(records);
    if (update === undefined) {
      io.stdout("policy: no change worth making (insufficient signal or already optimal)");
      return 0;
    }
    const outPath = resolve(io.cwd, flags.out ?? "graphflow-out/efficiency-policy.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(update, null, 2) + "\n", "utf8");
    io.stdout("policy: v" + update.version + " written to " + outPath);
    for (const line of update.rationale) io.stdout("  - " + line);
    return 0;
  } catch (error) {
    io.stderr("policy learn failed: " + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

// Direct execution guard
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  runCli(process.argv.slice(2)).then(async (code) => {
    await closeGraphFlowClients();
    process.exitCode = code;
  });
}
