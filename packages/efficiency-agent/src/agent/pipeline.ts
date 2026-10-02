import { createHash, randomUUID } from "node:crypto";
import type { ExecutionContractV1, ModelTier } from "../contract.js";
import { assertAdvisoryCompatible } from "../contract.js";
import { createContextCache, type KVStore } from "../caches/context-cache.js";
import { cacheNamespace, namespacedStore } from "../caches/namespace.js";
import { createPlanCache } from "../caches/plan-cache.js";
import { createResultCache, DEFAULT_RESULT_TTL_MS } from "../caches/result-cache.js";
import { chooseAction } from "../cost/optimizer.js";
import type {
  ActionCandidate,
  BrokerResult,
  CacheVerdict,
  PolicyUpdate,
  ReflectionFinding,
  ReuseDecision,
  TaskFingerprint,
  WorkerAdapter,
} from "../domain.js";
import { createTemporaryHarness, type HarnessComplexity, type HarnessExecutionResult } from "../dynamic-harness.js";
import { buildTaskFingerprint, normalizeSemanticTask } from "../fingerprint.js";
import { DEFAULT_FLAGS, effectiveMode, type EffFlags, type RequestedMode } from "../flags.js";
import type { CollectedProjectFacts } from "../host/project-facts.js";
import type { GraphFlowContext, GraphFlowContextResult } from "../host/graphflow-mcp-client.js";
import { createPolicyLifecycle, type StagedPolicy } from "../learning/policy-lifecycle.js";
import { learnPolicy } from "../learning/policy-learner.js";
import { createPolicyStore } from "../learning/policy-store.js";
import { summarizeTrajectories } from "../learning/trajectory.js";
import { estimated, measured, proxy } from "../measurement.js";
import { createEventRecorder } from "../observability/events.js";
import { buildProjectFacts, observeValidation, type ProjectFact } from "../project/facts.js";
import { buildProjectTwin, type ProjectTwin } from "../project-twin.js";
import { decideReuse } from "../reuse-gate.js";
import { runSelfOptimizeCycle } from "../self-optimize/loop.js";
import { createToolRegistry, type ToolCapability } from "../tools/capability-registry.js";
import { routeTools, type ToolSelection } from "../tools/tool-router.js";
import { isTraceTaskCategory, type TaskTrace, type TraceDecisionRecord, type TraceEvent, type TraceSecurityDecision } from "../trace.js";
import { CONTEXT_POLICY_VERSION, CONTRACT_VERSION, EFF_AGENT_VERSION } from "../version.js";
import { createAgentTaskWorker, type AgentExecutorSpec } from "../workers/agent-task-worker.js";
import { createLocalCommandWorker } from "../workers/local-command-worker.js";
import { classifyHarnessComplexity, classifyTaskCategory, isReadOnlyCategory } from "./classify.js";
import {
  searchExperience,
  toTrajectories,
  type ExperienceRecord,
  type ExperienceStore,
  type RunStatus,
  type SimilarExperience,
} from "./experience.js";
import { combineDecisions, type PipelineSecurity, type SecurityContext } from "./security-adapter.js";
import { createDefaultSecurity } from "./security-default.js";

/**
 * Efficiency Agent pipeline (2.x plan §27): flags → fingerprint → project
 * twin → experience search → reuse gate → security gate → tool selection →
 * model routing → dynamic harness → execute/validate/replan → write audit →
 * experience update → trace.
 *
 * Arms (§24/§26):
 *  - baseline:  no efficiency layer — the raw task goes to the worker.
 *  - shadow:    every decision is computed and recorded, the worker still
 *               gets the baseline prompt and always executes (FRESH).
 *  - broker:    decisions are applied under a policy — conservative reuses
 *               context/plan only (result replay off), adaptive may replay a
 *               validated read-only result.
 *  - advisory:  stop after the Execution Contract; nothing executes.
 *
 * Feature flags (§22) cap the arm: with EFF_AGENT_ENABLED=0 or
 * EFF_SHADOW_MODE=1 a broker run degrades to shadow (one-switch rollback).
 */

export type PipelineMode = "baseline" | "shadow" | "broker" | "advisory";
export type PipelinePolicy = "conservative" | "adaptive";

export interface PipelineInput {
  task: string;
  root: string;
  mode: PipelineMode;
  policy: PipelinePolicy;
  category?: string;
  validation: string[];
  /** The agent CLI that performs tasks; absent → only validation can run. */
  executor?: AgentExecutorSpec;
  /** Overall budget for the harness (default by complexity). */
  budgetMs?: number;
  /** Effective feature flags (defaults: spec §22). */
  flags?: EffFlags;
  /** Operator pre-approved R2 actions for this run (`--approve`). */
  approved?: boolean;
}

export interface PipelineDeps {
  collectFacts(root: string, task: string): CollectedProjectFacts;
  /** GraphFlow context over MCP; undefined → GraphFlow not configured. */
  fetchContext?: (task: string, root: string) => Promise<GraphFlowContextResult>;
  /** Start the context server now so its boot overlaps with fact collection. */
  prewarmContext?: (root: string) => void;
  graphVersion?: (root: string) => string | undefined;
  cacheStore: KVStore;
  toolStore: KVStore;
  policyKv: KVStore;
  experience: ExperienceStore;
  traceSink?: (trace: TaskTrace) => void;
  now?: () => number;
  /** Test seam: build the executor worker (defaults to the agent CLI worker). */
  createExecutorWorker?: typeof createAgentTaskWorker;
  /** Security gate (defaults to the bundled policy, fail-closed to STRICT). */
  security?: PipelineSecurity;
  /** Cache freshness overrides (defaults: context 24 h, result 6 h). */
  cacheTtlMs?: { context?: number; result?: number };
}

export interface PipelineResult {
  task: string;
  mode: PipelineMode;
  requestedMode: RequestedMode;
  modeCapReason?: string;
  policy: PipelinePolicy;
  category: string;
  status: RunStatus;
  statusReason: string;
  fingerprint: TaskFingerprint;
  twin: Pick<ProjectTwin, "project" | "modules" | "tests" | "build" | "conventions" | "preferredTools" | "knownIssues"> & {
    relevantFiles: string[];
    fileCount: number;
    /** §13: every fact with source, observedAt, validAt and provenance. */
    facts: ProjectFact[];
  };
  experience: { similar: Array<{ task: string; status: string; similarity: number }>; dialogueHits: number };
  context: {
    source: "graphflow" | "graphflow-cache" | "twin-only" | "none";
    anchors: string[];
    summaryLines: number;
    compressedTokens?: number;
    error?: string;
  };
  verdicts: CacheVerdict[];
  rawDecision: ReuseDecision;
  appliedDecision: ReuseDecision;
  tools: ToolSelection;
  costChoice?: { chosen?: string; rejected: Array<{ id: string; reason: string }> };
  harness: { complexity: HarnessComplexity; budgetMs: number; maxRounds: number; dynamic: boolean };
  security: TraceSecurityDecision;
  /** Post-run write audit; the subset lists are present only when non-empty. */
  writeAudit?: {
    verdict: TraceSecurityDecision["verdict"];
    newlyChanged: string[];
    rewrittenDirty?: string[];
    ignoredChanged?: string[];
    outsideRoot?: string[];
  };
  contract: ExecutionContractV1;
  contractViolations: string[];
  execution?: {
    rounds: number;
    durationMs: number;
    agentInvocations: number;
    validation: Array<{ name: string; passed: boolean }>;
    stopReason?: string;
    output?: string;
  };
  reflections: ReflectionFinding[];
  policyVersion?: number;
  record: TraceDecisionRecord;
  events: TraceEvent[];
  /** Non-fatal degradations (fail-open paths taken). */
  warnings: string[];
  /** Set when the efficiency layer failed and the run fell back to the native worker path (§9). */
  failOpen?: { reason: string };
  trace?: TaskTrace;
  durationMs: number;
}

export const CONTEXT_TTL_MS = 24 * 60 * 60_000;
export const RESULT_TTL_MS = DEFAULT_RESULT_TTL_MS;
const DEFAULT_BUDGET: Record<HarnessComplexity, number> = {
  trivial: 5_000,
  simple: 10 * 60_000,
  medium: 20 * 60_000,
  complex: 40 * 60_000,
};
const PROMPT_CAP = 16_000;
const EXECUTOR_DEFAULT_LATENCY_MS = 5 * 60_000;

function sha16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function emptyPolicy(): PolicyUpdate {
  return {
    version: 0,
    minSamples: 5,
    modelTierByCategory: {},
    executionModeByCategory: {},
    avoidPatterns: [],
    rationale: [],
  };
}

function ttlOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ───────────── tool registry persistence ─────────────

interface ToolState {
  tools: ToolCapability[];
  latency: Record<string, number[]>;
}

function loadToolState(store: KVStore): ToolState {
  try {
    const raw = store.get("tool-state");
    if (raw) {
      const parsed = JSON.parse(raw) as ToolState;
      if (Array.isArray(parsed.tools)) return { tools: parsed.tools, latency: parsed.latency ?? {} };
    }
  } catch {
    // Corrupt state: start from an empty registry.
  }
  return { tools: [], latency: {} };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function availableTools(input: PipelineInput): ToolCapability[] {
  const tools: ToolCapability[] = [
    {
      name: "result-cache",
      capabilities: ["replay_result"],
      latencyMsP50: 0,
      costPerCallUsd: 0,
      requiredContext: ["validated-result"],
      successHistory: { attempts: 0, successes: 0 },
      permission: [],
      risk: "R0",
      version: EFF_AGENT_VERSION,
    },
    {
      name: "local-command",
      capabilities: ["run_command", "validate"],
      costPerCallUsd: 0,
      requiredContext: [],
      successHistory: { attempts: 0, successes: 0 },
      permission: ["process.exec", "filesystem.read"],
      risk: "R1",
      version: EFF_AGENT_VERSION,
    },
  ];
  if (input.executor) {
    tools.push({
      name: `agent:${input.executor.command}`,
      capabilities: ["edit_code", "answer_query", "run_command"],
      requiredContext: ["task"],
      successHistory: { attempts: 0, successes: 0 },
      permission: ["process.exec", "filesystem.read", "filesystem.write"],
      risk: "R1",
    });
  }
  return tools;
}

function buildRegistry(state: ToolState, input: PipelineInput, learned: boolean) {
  const known = new Map(state.tools.map((tool) => [tool.name, tool]));
  const registry = createToolRegistry();
  for (const tool of availableTools(input)) {
    const prior = learned ? known.get(tool.name) : undefined;
    const p50 = learned ? median(state.latency[tool.name] ?? []) : undefined;
    registry.register({
      ...tool,
      successHistory: prior?.successHistory ?? tool.successHistory,
      ...(p50 !== undefined ? { latencyMsP50: p50 } : {}),
    });
  }
  return registry;
}

// ───────────── prompts ─────────────

function baselinePrompt(task: string): string {
  return [
    `TASK: ${task}`,
    "",
    "When done, reply with a short summary of what you changed, or the answer.",
    "If the task is impossible or its premise is false, say so explicitly and make no changes.",
  ].join("\n");
}

function efficiencyPrompt(input: {
  task: string;
  root: string;
  contract: ExecutionContractV1;
  twin: ProjectTwin;
  relevantFiles: string[];
  context?: GraphFlowContext;
  similar: SimilarExperience[];
  priorPlan?: { relevantFiles?: string[]; validation?: string[] };
  round: number;
  feedback?: string;
  wrapUntrusted: (source: string, text: string) => string;
}): string {
  const lines: string[] = [
    `TASK: ${input.task}`,
    "",
    `REPOSITORY: ${input.root} (project ${input.twin.project})`,
    `EXECUTION CONTRACT: reuse=${input.contract.reuseMode}; model tier=${input.contract.worker.modelTier}; ` +
      `mode=${input.contract.worker.executionMode}; max rounds=${input.contract.worker.maxRounds}`,
    `VALIDATION (must pass): ${input.contract.validation.length > 0 ? input.contract.validation.join(" && ") : "none given"}`,
  ];
  if (input.contract.permissions) {
    const p = input.contract.permissions;
    lines.push(
      `PERMISSIONS: write=${p.write.length > 0 ? p.write.join(", ") : "none (read-only task)"}; network=${p.network ? "allowed" : "not allowed"}`
    );
  }
  if (input.twin.tests.length > 0 || input.twin.build.length > 0) {
    lines.push(`PROJECT SCRIPTS: build=[${input.twin.build.join(", ")}] test=[${input.twin.tests.join(", ")}]`);
  }
  if (input.relevantFiles.length > 0) {
    lines.push(`RELEVANT FILES: ${input.relevantFiles.join(", ")}`);
  }
  if (input.contract.context.requiredAnchors.length > 0) {
    lines.push(`GRAPHFLOW ANCHORS: ${input.contract.context.requiredAnchors.join(", ")}`);
  }
  if (input.context && input.context.summary.length > 0) {
    const summary = input.context.summary.slice(0, 15).map((s) => `- ${s.split("\n")[0]}`).join("\n");
    lines.push("", "GRAPHFLOW CONTEXT (compressed):", input.wrapUntrusted("graphflow-context", summary));
  }
  if (input.contract.reuseMode === "ADAPT" && input.priorPlan) {
    lines.push(
      "",
      "PRIOR VALIDATED PLAN (same task, same project state — adapt it, do not re-explore):",
      ...(input.priorPlan.relevantFiles?.length ? [`- files that mattered: ${input.priorPlan.relevantFiles.join(", ")}`] : []),
      ...(input.priorPlan.validation?.length ? [`- validation that passed: ${input.priorPlan.validation.join(" && ")}`] : [])
    );
  }
  if (input.similar.length > 0) {
    const past = input.similar
      .map((s) => `- (${s.similarity}) "${s.record.task}" → ${s.record.status}${s.record.lesson ? ` [${s.record.lesson}]` : ""}`)
      .join("\n");
    lines.push("", "PAST SIMILAR TASKS:", input.wrapUntrusted("experience", past));
  }
  if (input.contract.experience?.avoidPatterns?.length) {
    lines.push("", "AVOID (learned anti-patterns):", ...input.contract.experience.avoidPatterns.map((p) => `- ${p}`));
  }
  if (input.round > 1 && input.feedback) {
    lines.push(
      "",
      `ROUND ${input.round} — the previous attempt failed validation. Fix only what this shows:`,
      input.wrapUntrusted("validation-output", input.feedback)
    );
  }
  lines.push(
    "",
    "When done, reply with a short summary of what you changed, or the answer.",
    "If the task is impossible or its premise is false, say so explicitly and make no changes."
  );
  const prompt = lines.join("\n");
  return prompt.length > PROMPT_CAP ? prompt.slice(0, PROMPT_CAP) : prompt;
}

// ───────────── pipeline ─────────────

export async function runEfficiencyPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const startedIso = new Date(startedAt).toISOString();
  const warnings: string[] = [];
  let category: string = classifyTaskCategory(input.task);
  if (input.category !== undefined) {
    if (isTraceTaskCategory(input.category)) {
      category = input.category;
    } else {
      warnings.push(`unknown category "${input.category}"; classified as ${category}`);
    }
  }
  const readOnly = isReadOnlyCategory(category);
  const flags: EffFlags = { ...(input.flags ?? DEFAULT_FLAGS) };
  const security = deps.security ?? createDefaultSecurity();
  const contextTtlMs = ttlOrDefault(deps.cacheTtlMs?.context, CONTEXT_TTL_MS);
  const resultTtlMs = ttlOrDefault(deps.cacheTtlMs?.result, RESULT_TTL_MS);

  // 0. Flags cap the requested arm (one-switch rollback).
  const requestedMode: RequestedMode = input.mode === "broker" ? input.policy : input.mode;
  const capped = effectiveMode(requestedMode, flags);
  const mode: PipelineMode = capped.capped ? "shadow" : input.mode;
  const efficiencyActive = mode !== "baseline";
  const acting = mode === "broker";

  // Policy load: a corrupt policy store is a policy failure → ignore learned
  // overrides (deterministic defaults) and say so.
  const policyStore = createPolicyStore(deps.policyKv);
  const lifecycle = createPolicyLifecycle(deps.policyKv);
  let productionPolicy: PolicyUpdate | undefined;
  let staged: StagedPolicy | undefined;
  let antiPatterns: string[] = [];
  try {
    productionPolicy = policyStore.current();
    if (flags.EFF_SELF_LEARNING) {
      staged = lifecycle.staged();
      antiPatterns = lifecycle.antiPatterns();
    }
  } catch (error) {
    productionPolicy = undefined;
    staged = undefined;
    warnings.push(`policy store unreadable (${errorText(error)}); learned overrides ignored`);
  }
  // §15 canary: a deterministic slice of tasks runs the staged policy.
  const taskKey = `task:${sha16(normalizeSemanticTask(input.task))}`;
  const canaryArm = staged?.stage === "canary" && acting && lifecycle.inCanary(taskKey);
  const currentPolicy: PolicyUpdate | undefined = canaryArm ? staged!.update : productionPolicy;
  const policyVersion = currentPolicy?.version ?? 0;
  const events = createEventRecorder(policyVersion, now);
  events.record(
    "flags",
    capped.capped ? "capped" : "as-requested",
    capped.reason ?? `mode ${requestedMode}`,
    Object.entries(flags).map(([k, v]) => `${k}=${v ? 1 : 0}`)
  );
  if (warnings.length > 0) events.record("fail-open", "policy-defaults", warnings[0]!);

  if (efficiencyActive && deps.fetchContext && deps.prewarmContext) {
    try {
      deps.prewarmContext(input.root);
    } catch {
      // the context fetch reports its own failure
    }
  }

  // 1. Fingerprint (real project state) + 2. Project Twin.
  const facts = deps.collectFacts(input.root, input.task);
  let history: ExperienceRecord[] = [];
  try {
    history = deps.experience.read();
  } catch (error) {
    warnings.push(`experience store unreadable (${errorText(error)}); searching without history`);
    events.record("fail-open", "no-history", warnings[warnings.length - 1]!);
  }
  const similar = efficiencyActive ? searchExperience(input.task, history) : [];
  events.record(
    "experience",
    similar.length > 0 ? "similar-found" : "none",
    `${similar.length} similar of ${history.length} past runs`,
    similar.map((s) => `${s.record.taskId}:${s.similarity}`)
  );
  const toolState = loadToolState(deps.toolStore);
  const registry = buildRegistry(toolState, input, flags.EFF_TOOL_ROUTING);
  const baseTwin = buildProjectTwin(facts.twinFacts);
  const twin: ProjectTwin = {
    ...baseTwin,
    preferredTools: registry
      .list()
      .filter((tool) => tool.successHistory.attempts > 0)
      .sort((a, b) => b.successHistory.successes / b.successHistory.attempts - a.successHistory.successes / a.successHistory.attempts)
      .map((tool) => tool.name),
    knownIssues: history
      .filter((record) => record.status === "failed" && record.lesson)
      .slice(-5)
      .map((record) => `${record.task.slice(0, 60)}: ${record.lesson}`),
  };
  const graphVersion = deps.graphVersion?.(input.root);
  const toolVersions: Record<string, string> = {
    node: process.version,
    "eff-agent": EFF_AGENT_VERSION,
    "security-policy": security.policyVersion,
  };
  const fingerprint = buildTaskFingerprint({
    task: input.task,
    project: facts.projectState,
    context: {
      ...(graphVersion ? { graphVersion } : {}),
      // Learned policy and security policy are part of the context track: a
      // new policy version invalidates every cached context/plan/result.
      contextPolicyVersion: `${CONTEXT_POLICY_VERSION}+policy:${policyVersion}+sec:${security.policyVersion}`,
      workingSetHash: sha16(facts.relevantFiles.join("\n")),
    },
    environment: {
      toolVersions,
      runtimeVersion: process.version,
      selectedProvider: input.executor?.command ?? "none",
      // A result validated under other commands, or produced by the agent with
      // other arguments, is not the same result. Env values stay out (secrets).
      dynamicStateFingerprint: sha16(
        JSON.stringify({
          validation: input.validation,
          args: input.executor?.args ?? [],
          promptVia: input.executor?.promptVia ?? "",
          envKeys: Object.keys(input.executor?.env ?? {}).sort(),
        })
      ),
    },
  });
  events.record("fingerprint", "computed", "four-track fingerprint", [fingerprint.reuseKey]);
  let projectFacts: ProjectFact[] = [];
  try {
    projectFacts = buildProjectFacts(facts, { now: startedAt, ...(graphVersion ? { graphVersion } : {}), ttlMs: contextTtlMs });
  } catch (error) {
    warnings.push(`project facts unavailable (${errorText(error)})`);
  }
  events.record("twin", "built", `${facts.twinFacts.fileMap.length} files mapped, ${projectFacts.length} provenance facts`, facts.relevantFiles.slice(0, 8));

  // 3. Cache verdicts (efficiency arms only), inside the active namespace.
  let namespace = "unavailable";
  let contextLookup: ReturnType<ReturnType<typeof createContextCache>["get"]> | undefined;
  let planLookup: ReturnType<ReturnType<typeof createPlanCache>["get"]> | undefined;
  let resultLookup: ReturnType<ReturnType<typeof createResultCache>["get"]> | undefined;
  let contextCache: ReturnType<typeof createContextCache> | undefined;
  let planCache: ReturnType<typeof createPlanCache> | undefined;
  let resultCache: ReturnType<typeof createResultCache> | undefined;
  try {
    namespace = cacheNamespace(deps.cacheStore);
    const scoped = namespacedStore(deps.cacheStore, namespace);
    contextCache = createContextCache(scoped, { ttlMs: contextTtlMs });
    planCache = createPlanCache(scoped);
    resultCache = createResultCache(scoped, { ttlMs: resultTtlMs });
    const t = now();
    if (efficiencyActive && flags.EFF_CONTEXT_REUSE) contextLookup = contextCache.get(fingerprint, t);
    if (efficiencyActive && flags.EFF_PLAN_REUSE) planLookup = planCache.get(fingerprint, t);
    if (efficiencyActive && flags.EFF_RESULT_REUSE) resultLookup = resultCache.get(fingerprint, category, t);
  } catch (error) {
    // Cache store unusable → FRESH, never a guess.
    contextLookup = planLookup = resultLookup = undefined;
    contextCache = planCache = resultCache = undefined;
    warnings.push(`cache store failed (${errorText(error)}); FRESH`);
    events.record("fail-open", "fresh", warnings[warnings.length - 1]!);
  }
  const verdicts = [contextLookup?.verdict, planLookup?.verdict, resultLookup?.verdict].filter(
    (v): v is CacheVerdict => v !== undefined
  );
  const disabledReuse = [
    flags.EFF_CONTEXT_REUSE ? undefined : "context",
    flags.EFF_PLAN_REUSE ? undefined : "plan",
    flags.EFF_RESULT_REUSE ? undefined : "result",
  ].filter((v): v is string => v !== undefined);

  // 4. Context: cached package, else GraphFlow over MCP, else twin only.
  let context: GraphFlowContext | undefined;
  let contextSource: PipelineResult["context"]["source"] = "none";
  let contextError: string | undefined;
  if (efficiencyActive) {
    if (contextLookup?.verdict.hit && contextLookup.payload) {
      context = contextLookup.payload as GraphFlowContext;
      contextSource = "graphflow-cache";
    } else if (deps.fetchContext) {
      let fetched: GraphFlowContextResult;
      try {
        fetched = await deps.fetchContext(input.task, input.root);
      } catch (error) {
        fetched = { ok: false, error: errorText(error), durationMs: 0 };
      }
      if (fetched.ok) {
        context = fetched.context;
        contextSource = "graphflow";
        try {
          contextCache?.put(fingerprint, fetched.context, now());
        } catch (error) {
          warnings.push(`context cache write failed (${errorText(error)})`);
        }
      } else {
        contextError = fetched.error;
        contextSource = "twin-only";
        events.record("fail-open", "twin-only", `GraphFlow unavailable: ${fetched.error}`);
      }
    } else {
      contextError = "GraphFlow MCP server not configured";
      contextSource = "twin-only";
    }
    events.record(
      "context",
      contextSource,
      contextLookup && !contextLookup.verdict.hit ? `cache miss: ${contextLookup.verdict.reason}` : contextSource,
      (context?.anchors ?? []).slice(0, 8).map((a) => a.id)
    );
  }
  const relevantFiles = Array.from(new Set([...facts.relevantFiles, ...(context?.anchorFiles ?? [])])).slice(0, 12);

  // 5. Reuse gate, then the mode/policy that decides what is applied.
  const rawDecision = decideReuse({ verdicts, category });
  let appliedDecision: ReuseDecision = rawDecision;
  if (!acting) {
    appliedDecision = {
      ...rawDecision,
      reuseMode: "FRESH",
      confidence: 0.5,
      rationale: [...rawDecision.rationale, `${mode}: decision recorded, worker behaviour unchanged (FRESH)`],
    };
  } else if (rawDecision.reuseMode === "REUSE" && input.policy === "conservative") {
    appliedDecision = {
      ...rawDecision,
      reuseMode: "ADAPT",
      confidence: 0.65,
      rationale: [...rawDecision.rationale, "conservative policy: result replay disabled → ADAPT"],
    };
  }
  events.record(
    "reuse-gate",
    appliedDecision.reuseMode,
    appliedDecision.rationale.join("; ") || "no cache verdicts",
    [
      ...verdicts.map((v) => `${v.kind}:${v.hit ? "hit" : "miss"}:${v.reason}`),
      ...(disabledReuse.length > 0 ? [`disabled by flags: ${disabledReuse.join(",")}`] : []),
    ]
  );

  // 6. Security gate: what eff-agent itself will launch, and where it may write.
  const writeScope = readOnly ? [] : [input.root];
  const secCtx: SecurityContext = {
    workspaceRoot: input.root,
    readOnly,
    network: flags.EFF_NETWORK_DEFAULT,
    externalWriteApproval: flags.EFF_EXTERNAL_WRITE_APPROVAL,
    subAgents: flags.EFF_SUBAGENT,
    writeScope,
  };
  let securityDecision: TraceSecurityDecision;
  try {
    securityDecision = combineDecisions([
      security.checkCommands(input.validation, secCtx),
      ...(input.executor ? [security.checkWorkerLaunch(input.executor, secCtx)] : []),
      ...(writeScope.length > 0 ? [security.checkWriteScope(secCtx)] : []),
    ]);
  } catch (error) {
    // Policy evaluation failure is fail-closed.
    securityDecision = { verdict: "deny", risk: "R3", reasons: [`security evaluation failed: ${errorText(error)}`] };
  }
  if (securityDecision.verdict === "approval-required" && input.approved) {
    securityDecision = { ...securityDecision, verdict: "allow", reasons: [...securityDecision.reasons, "approved by operator (--approve)"] };
  }
  events.record("security", securityDecision.verdict, `risk ${securityDecision.risk}`, securityDecision.reasons);

  // 7. Tool selection by capability (fixed selection when routing is off).
  const needs = [
    ...(appliedDecision.reuseMode === "REUSE" ? ["replay_result"] : [readOnly ? "answer_query" : "edit_code"]),
    ...(input.validation.length > 0 ? ["validate"] : []),
  ];
  const tools = routeTools(needs, registry);
  events.record(
    "tool-routing",
    flags.EFF_TOOL_ROUTING ? "routed" : "fixed",
    flags.EFF_TOOL_ROUTING ? "capability match ranked by measured history" : "EFF_TOOL_ROUTING=0: history ignored",
    [...tools.selected.map((t) => t.name), ...tools.rejected.map((r) => `rejected ${r.name}: ${r.reason}`)]
  );

  // 8. Model routing (learned policy wins) + harness sizing.
  const dynamicHarness = flags.EFF_DYNAMIC_HARNESS;
  const complexity: HarnessComplexity = dynamicHarness
    ? classifyHarnessComplexity({ category, reuseMode: appliedDecision.reuseMode, relevantFileCount: relevantFiles.length })
    : appliedDecision.reuseMode === "REUSE"
      ? "trivial"
      : "medium";
  const learnedTier = flags.EFF_MODEL_ROUTING ? currentPolicy?.modelTierByCategory[category] : undefined;
  const modelTier: ModelTier = flags.EFF_MODEL_ROUTING
    ? (learnedTier ?? (complexity === "complex" ? "standard" : "economy"))
    : "standard";
  const learnedMode = flags.EFF_MODEL_ROUTING ? currentPolicy?.executionModeByCategory[category] : undefined;
  const executionMode = learnedMode ?? (complexity === "simple" || complexity === "trivial" ? "one-shot" : "loop");
  let maxRounds = executionMode === "one-shot" ? 1 : input.policy === "adaptive" && acting ? 3 : 2;
  if (input.validation.length === 0) maxRounds = 1; // nothing to replan against
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET[complexity];
  events.record(
    "model-routing",
    modelTier,
    flags.EFF_MODEL_ROUTING ? (learnedTier ? `learned policy v${policyVersion}` : `complexity ${complexity}`) : "EFF_MODEL_ROUTING=0: fixed tier",
    [`harness=${complexity}${dynamicHarness ? "" : " (fixed: EFF_DYNAMIC_HARNESS=0)"}`, `mode=${executionMode}`, `maxRounds=${maxRounds}`, `budgetMs=${budgetMs}`]
  );

  const decisionId = randomUUID();
  const decisionMs = now() - startedAt;
  const contract: ExecutionContractV1 = {
    schemaVersion: "1.0",
    taskId: `task:${sha16(normalizeSemanticTask(input.task))}`,
    decisionId,
    mode: mode === "broker" ? input.policy : "shadow",
    reuseMode: appliedDecision.reuseMode,
    confidence: appliedDecision.confidence,
    reuseEvidence: verdicts.map((v) => `${v.kind}:${v.hit ? "hit" : "miss"}:${v.reason}`),
    signals: {
      taskComplexity: complexity === "complex" || complexity === "medium" ? "complex" : "simple",
      executionMode: input.executor ? "llm" : "bridge",
      fusedStepCount: 0,
      similarEpisodeCount: similar.length,
      ...(similar[0] ? { topEpisodeScore: similar[0].similarity } : {}),
    },
    context: {
      source: "graphflow",
      requiredAnchors: (context?.anchors ?? []).slice(0, 8).map((a) => a.id),
      ...(context?.compressedTokens !== undefined ? { maxTokens: context.compressedTokens } : {}),
      cached: contextSource === "graphflow-cache",
    },
    project: {
      root: input.root,
      ...(facts.projectState.gitHead ? { gitHead: facts.projectState.gitHead } : {}),
      ...(facts.projectState.workingTreeHash ? { workingTreeHash: facts.projectState.workingTreeHash } : {}),
      ...(graphVersion ? { graphVersion } : {}),
      toolchainHash: fingerprint.environmentStateHash,
    },
    experience: {
      episodes: similar.map((s) => s.record.taskId),
      ...(similar[0] ? { topSimilarity: similar[0].similarity } : {}),
      skills: twin.preferredTools,
      avoidPatterns: Array.from(new Set([...(currentPolicy?.avoidPatterns ?? []), ...antiPatterns])),
    },
    tools: tools.selected.map((tool) => ({
      name: tool.name,
      capability: needs.find((need) => tool.capabilities.includes(need)) ?? tool.capabilities[0] ?? "unknown",
      ...(tool.risk ? { risk: tool.risk } : {}),
    })),
    ...(currentPolicy && flags.EFF_MODEL_ROUTING ? { policyApplied: { version: currentPolicy.version } } : {}),
    worker: {
      modelTier,
      executionMode,
      maxRounds,
      provider: input.executor ? input.executor.command : "local-command",
    },
    validation: [...input.validation],
    validationPolicy: { required: input.validation.length > 0, evidenceRequired: true },
    budget: {
      maxInputTokens: Math.ceil(PROMPT_CAP / 4),
      maxOutputTokens: 16_000,
      maxToolCalls: maxRounds * (1 + input.validation.length),
      maxRounds,
      maxWallMs: budgetMs,
    },
    permissions: {
      read: [input.root],
      write: [...writeScope],
      network: flags.EFF_NETWORK_DEFAULT,
    },
    decision: { provenance: "deterministic", llmCalls: 0, durationMs: Math.max(0, Math.round(decisionMs)) },
  };
  const contractViolations = assertAdvisoryCompatible(contract);

  // 9. Cost-aware action choice among what the router can actually serve.
  const candidates: ActionCandidate[] = [];
  if (appliedDecision.reuseMode === "REUSE" && resultLookup?.payload !== undefined) {
    candidates.push({ id: "replay-result", cost: measured(0), expectedSuccessRate: 0.95, expectedFidelity: 1, safety: 1, evidence: 1 });
  }
  const executorTool = tools.selected.find((tool) => tool.name.startsWith("agent:"));
  if (executorTool) {
    const { attempts, successes } = executorTool.successHistory;
    candidates.push({
      id: `execute:${executorTool.name}`,
      cost:
        executorTool.latencyMsP50 !== undefined
          ? estimated(executorTool.latencyMsP50, "historical-latency-p50-ms", 0.6)
          : estimated(EXECUTOR_DEFAULT_LATENCY_MS, "no-history-default-latency-ms", 0.2),
      expectedSuccessRate: attempts === 0 ? 0.5 : successes / attempts,
      expectedFidelity: 1,
      safety: securityDecision.verdict === "allow" ? 1 : 0,
      evidence: Math.min(1, attempts / 5),
    });
  }
  const costChoice = candidates.length > 0 ? chooseAction(candidates, { minSafety: 1 }) : undefined;
  if (costChoice) {
    events.record(
      "cost",
      costChoice.chosen?.id ?? "none",
      costChoice.chosen ? "highest expected value within safety floor" : "no candidate passed the safety floor",
      costChoice.rejected.map((r) => `${r.id}: ${r.reason}`)
    );
  }

  // 10. Execute through the dynamic harness.
  let status: RunStatus = "advisory-only";
  let statusReason = "advisory mode: contract only, nothing executed";
  let harnessResult: HarnessExecutionResult | undefined;
  let output: string | undefined;
  let agentInvocations = 0;
  let promptChars = 0;
  let writeAudit: PipelineResult["writeAudit"];

  if (mode !== "advisory") {
    // The security verdict gates replay too: a cached answer must not bypass a
    // deny/approval-required decision on the current request.
    if (securityDecision.verdict !== "allow") {
      status = "blocked";
      statusReason =
        securityDecision.verdict === "approval-required"
          ? `approval required (${securityDecision.risk}): ${securityDecision.reasons.join("; ")} — re-run with --approve after review`
          : `denied by security policy (${securityDecision.risk}): ${securityDecision.reasons.join("; ")}`;
      events.record("execute", "blocked", statusReason);
    } else if (costChoice?.chosen?.id === "replay-result") {
      status = "reused";
      statusReason = "validated read-only result replayed from the result cache";
      output = String((resultLookup?.payload as { output?: string } | undefined)?.output ?? "");
      events.record("execute", "replayed", statusReason, [fingerprint.reuseKey]);
    } else if (!input.executor && input.validation.length === 0) {
      status = "not-executed";
      statusReason =
        "no executor configured: the local worker only runs validation commands. Pass --worker external --cli-command <agent CLI> to perform the task, or --validation <cmd> to check it.";
      events.record("execute", "not-executed", statusReason);
    } else {
      let worker: WorkerAdapter;
      let agent: ReturnType<typeof createAgentTaskWorker> | undefined;
      if (input.executor) {
        const make = deps.createExecutorWorker ?? createAgentTaskWorker;
        agent = make({
          executor: input.executor,
          cwd: input.root,
          validation: input.validation,
          buildPrompt: (round, feedback) => {
            const prompt = acting
              ? efficiencyPrompt({
                  task: input.task,
                  root: input.root,
                  contract,
                  twin,
                  relevantFiles,
                  ...(context ? { context } : {}),
                  similar,
                  ...(planLookup?.verdict.hit && planLookup.payload
                    ? { priorPlan: planLookup.payload as { relevantFiles?: string[]; validation?: string[] } }
                    : {}),
                  round,
                  ...(feedback !== undefined ? { feedback } : {}),
                  wrapUntrusted: (source, text) => security.wrapUntrusted(source, text),
                })
              : round > 1 && feedback
                ? `${baselinePrompt(input.task)}\n\nThe previous attempt failed validation:\n${feedback}`
                : baselinePrompt(input.task);
            promptChars += prompt.length;
            return prompt;
          },
        });
        worker = agent;
      } else {
        worker = createLocalCommandWorker();
      }
      let lastFailure: string | undefined;
      let seenObservations = 0;
      let repeated = false;
      const harness = createTemporaryHarness(complexity, {
        budgetCapMs: budgetMs,
        maxRounds,
        retryPolicy: { maxRetries: Math.max(0, maxRounds - 1) },
        stopConditions: [
          (ctx) => {
            // The harness checks before and after each round; judge new rounds only.
            if (ctx.observations.length === seenObservations) return repeated;
            seenObservations = ctx.observations.length;
            const last = ctx.observations[ctx.observations.length - 1]!;
            // The agent's own exit is not enough: a clean agent exit with a
            // changing validation failure is progress, not repetition.
            const signature = `${last.exitCode}|${last.stderrTail ?? ""}|${agent?.lastFeedback?.() ?? ""}`;
            repeated = signature === lastFailure; // same failure twice: replanning is not converging
            lastFailure = signature;
            return repeated;
          },
        ],
        contextPlanner: async () => ({ requiredAnchors: contract.context.requiredAnchors }),
      });
      const before = input.executor ? security.snapshot(input.root) : undefined;
      try {
        harnessResult = await harness.run(contract, worker);
      } finally {
        await harness.dispose();
      }
      agentInvocations = agent?.invocations() ?? 0;
      output = agent?.lastOutput();
      events.record(
        "execute",
        harnessResult.status,
        `${harnessResult.rounds} round(s), ${agentInvocations} agent invocation(s)`,
        harnessResult.stopReason ? [harnessResult.stopReason] : []
      );
      if (harnessResult.rounds > 1) events.record("replan", "retried", `${harnessResult.rounds - 1} replan round(s)`);
      if (!input.executor) {
        status = "validation-only";
        statusReason = harnessResult.status === "completed"
          ? "validation passed — the task itself was not performed by eff-agent (no executor)"
          : "validation failed — no executor configured to perform the task";
        if (harnessResult.status !== "completed") status = "failed";
      } else if (harnessResult.status === "completed") {
        status = "completed";
        statusReason = "agent executed and every validation command passed";
      } else if (agent?.unverified()) {
        status = "unverified";
        statusReason = "agent executed cleanly but no validation command judged the result";
      } else if (harnessResult.status === "budget-exhausted") {
        status = "budget-exhausted";
        statusReason = `harness budget of ${budgetMs}ms exhausted`;
      } else {
        status = "failed";
        statusReason = `stop reason: ${harnessResult.stopReason ?? "unknown"}`;
      }
      if (input.executor) {
        // Post-run audit: writes the task/policy did not permit void the result.
        const after = before !== undefined ? security.snapshot(input.root, before) : undefined;
        const audit = security.auditWrites(before, after, secCtx);
        writeAudit = {
          verdict: audit.decision.verdict,
          newlyChanged: audit.newlyChanged,
          ...(audit.rewrittenDirty?.length ? { rewrittenDirty: audit.rewrittenDirty } : {}),
          ...(audit.ignoredChanged?.length ? { ignoredChanged: audit.ignoredChanged } : {}),
          ...(audit.outsideRoot?.length ? { outsideRoot: audit.outsideRoot } : {}),
        };
        events.record("security", `write-audit:${audit.decision.verdict}`, `risk ${audit.decision.risk}`, [
          ...audit.decision.reasons,
          ...audit.newlyChanged.slice(0, 5),
          ...(audit.rewrittenDirty ?? []).slice(0, 5).map((p) => `rewritten-dirty:${p}`),
          ...(audit.ignoredChanged ?? []).slice(0, 5).map((p) => `ignored:${p}`),
          ...(audit.outsideRoot ?? []).slice(0, 5).map((p) => `outside-root:${p}`),
        ]);
        if (audit.decision.verdict !== "allow") {
          status = "violation";
          statusReason = `workspace writes not permitted: ${audit.decision.reasons.join("; ")}`;
          securityDecision = combineDecisions([securityDecision, audit.decision]);
        }
      }
    }
  }
  const rawOutput = output;
  if (output !== undefined) output = security.redact(output);

  const finishedAt = now();
  const totalMs = finishedAt - startedAt;
  const validationChecks = harnessResult?.validation?.checks ?? (status === "reused" ? [{ name: "cache-reuse", passed: true }] : []);
  if (harnessResult?.validation) {
    events.record(
      "validate",
      harnessResult.validation.passed ? "passed" : "failed",
      `${validationChecks.filter((c) => c.passed).length}/${validationChecks.length} checks passed`,
      validationChecks.filter((c) => !c.passed).map((c) => c.name)
    );
  }
  const brokerLike: BrokerResult | undefined = harnessResult
    ? {
        status: harnessResult.status,
        rounds: harnessResult.rounds,
        totalDurationMs: harnessResult.durationMs,
        observations: harnessResult.observations,
        ...(harnessResult.validation ? { validation: harnessResult.validation } : {}),
        ...(harnessResult.stopReason ? { stopReason: harnessResult.stopReason } : {}),
      }
    : undefined;

  // 11. Experience update: tool history, caches, reflection, policy learning.
  const executed =
    status === "completed" || status === "failed" || status === "unverified" || status === "budget-exhausted" || status === "violation";
  if (executorTool && executed) {
    registry.recordOutcome(executorTool.name, status === "completed");
    const samples = [...(toolState.latency[executorTool.name] ?? []), harnessResult?.durationMs ?? totalMs].slice(-20);
    toolState.latency[executorTool.name] = samples;
  }
  try {
    deps.toolStore.set("tool-state", JSON.stringify({ tools: registry.list(), latency: toolState.latency }));
  } catch (error) {
    warnings.push(`tool store write failed (${errorText(error)})`);
  }

  if (efficiencyActive && status === "completed") {
    try {
      planCache?.put(fingerprint, { contractTaskId: contract.taskId, validation: contract.validation, relevantFiles }, now());
      if (readOnly && rawOutput) {
        const admission = security.admitToCache({
          output: rawOutput,
          validationPassed: harnessResult?.validation?.passed === true,
          evidence: validationChecks.filter((c) => c.passed).map((c) => c.name),
        });
        if (admission.admit && output) resultCache?.put(fingerprint, category, { output: output.slice(-8_000) }, now());
        events.record("learn", admission.admit ? "result-cached" : "result-not-cached", admission.reason);
      }
    } catch (error) {
      warnings.push(`cache write failed (${errorText(error)})`);
    }
  }

  const record: ExperienceRecord = {
    taskId: contract.taskId,
    task: security.redact(input.task),
    category,
    status,
    worker: input.executor ? `agent:${input.executor.command}` : "local-command",
    reuseMode: appliedDecision.reuseMode,
    modelTier,
    rounds: harnessResult?.rounds ?? 0,
    durationMs: totalMs,
    agentInvocations,
    cacheHits: verdicts.filter((v) => v.hit).length,
    cacheMisses: verdicts.filter((v) => !v.hit).length,
    validationPassed: harnessResult?.validation?.passed ?? status === "reused",
    startedAt: startedIso,
    finishedAt: new Date(finishedAt).toISOString(),
    ...(status !== "completed" && status !== "reused" && status !== "advisory-only"
      ? {
          lesson: security.redact(
            (harnessResult?.validation?.checks ?? [])
              .filter((check) => !check.passed)
              .map((check) => check.name)
              .join(", ") || status
          ),
        }
      : {}),
  };
  // Nothing ran → nothing was learned; keep such runs out of experience search.
  // Telemetry down (experience store not writable) → no learning this run.
  let telemetryOk = true;
  if (mode !== "advisory" && status !== "not-executed" && status !== "blocked") {
    try {
      deps.experience.append(record);
    } catch (error) {
      telemetryOk = false;
      warnings.push(`experience store write failed (${errorText(error)}); learning skipped`);
      events.record("fail-open", "no-learning", warnings[warnings.length - 1]!);
    }
  }

  let reflections: ReflectionFinding[] = [];
  let appliedPolicyVersion = currentPolicy?.version;
  if (efficiencyActive && mode !== "advisory" && executed && telemetryOk) {
    const cycle = runSelfOptimizeCycle(
      {
        task: input.task,
        taskCategory: category,
        fingerprint,
        reuse: appliedDecision,
        policy: currentPolicy ?? emptyPolicy(),
        ...(brokerLike ? { result: brokerLike } : {}),
        totalDurationMs: totalMs,
        budgetMs,
      },
      {
        policyLearnerFn: () => learnPolicy(summarizeTrajectories(toTrajectories([...history, record])), currentPolicy),
      }
    );
    reflections = cycle.reflections;
    const update = cycle.policyUpdates[0];
    if (flags.EFF_SELF_LEARNING) {
      // §15: never apply directly — Evidence Gate → Shadow → Canary → Production.
      try {
        const success = status === "completed" || status === "reused";
        if (staged?.stage === "shadow") {
          const disagrees =
            staged.update.modelTierByCategory[category] !== productionPolicy?.modelTierByCategory[category] ||
            staged.update.executionModeByCategory[category] !== productionPolicy?.executionModeByCategory[category];
          lifecycle.recordShadow(disagrees);
        } else if (staged?.stage === "canary" && acting) {
          lifecycle.recordOutcome(canaryArm ? "canary" : "baseline", success);
        }
        const evaluation = lifecycle.evaluate(now());
        if (evaluation.stage !== "none") {
          events.record("learn", `lifecycle:${evaluation.stage}`, evaluation.reason);
          if (evaluation.promoted) appliedPolicyVersion = evaluation.promoted.version;
        }
        if (update && (evaluation.stage === "none" || evaluation.stage === "rejected" || evaluation.stage === "production")) {
          const proposed = lifecycle.propose(update, now());
          events.record("learn", `proposed:${proposed.stage}`, proposed.history[proposed.history.length - 1]?.reason ?? "", update.rationale.slice(0, 5));
        }
      } catch (error) {
        events.record("learn", "lifecycle-error", errorText(error));
      }
    } else if (update) {
      events.record("learn", "policy-proposed-only", "EFF_SELF_LEARNING=0: candidate policy not applied", update.rationale.slice(0, 5));
    }
  }

  const decisionRecord: TraceDecisionRecord = {
    decisionId,
    policyVersion,
    contractVersion: CONTRACT_VERSION,
    workerVersion: input.executor ? `agent:${input.executor.command}` : `local-command@${EFF_AGENT_VERSION}`,
    toolVersions,
    cacheNamespace: namespace,
    securityPolicyVersion: security.policyVersion,
    requestedMode,
    flags: { ...flags },
  };
  const validationStatus: TaskTrace["validationStatus"] = harnessResult?.validation
    ? harnessResult.validation.passed
      ? "passed"
      : status === "unverified"
        ? "unverified"
        : "failed"
    : status === "reused"
      ? "passed"
      : "not-run";

  // Trace (measurement contract): every number carries its provenance.
  let trace: TaskTrace | undefined;
  if (mode !== "advisory") {
    const runMode = mode === "broker" ? input.policy : mode === "shadow" ? "shadow" : "baseline";
    trace = {
      schemaVersion: "1.0",
      traceId: `${runMode}-${contract.taskId}-${startedAt}`,
      task: { text: input.task, taskId: contract.taskId, category },
      run: {
        worker: record.worker,
        mode: runMode,
        startedAt: startedIso,
        finishedAt: record.finishedAt,
      },
      sessionId: decisionId,
      projectId: sha16(input.root),
      fingerprint: fingerprint.reuseKey,
      model: { provider: input.executor?.command ?? "none", tier: modelTier },
      context: {
        tokens: estimated(Math.ceil(promptChars / 4), "prompt-chars/4", 0.7),
        anchors: contract.context.requiredAnchors.length,
        cacheHit: contextSource === "graphflow-cache",
        ...(contextLookup && !contextLookup.verdict.hit ? { invalidationReason: contextLookup.verdict.reason } : {}),
      },
      llm: {
        calls: agentInvocations === 0
          ? measured(0)
          : proxy(agentInvocations, "agent-cli-invocations (the agent's internal LLM calls are not observable)", 0.2),
      },
      tools: [
        ...(agentInvocations > 0 && executorTool
          ? [{ name: executorTool.name, calls: measured(agentInvocations), latencyMs: measured(harnessResult?.durationMs ?? 0) }]
          : []),
      ],
      rounds: measured(Math.max(1, harnessResult?.rounds ?? 1)),
      validation: validationChecks,
      validationStatus,
      securityDecision,
      result: { success: status === "completed" || status === "reused" },
      cost: { actual: measured(totalMs) },
      record: decisionRecord,
      events: events.events(),
      ...(efficiencyActive
        ? {
            decision: {
              reuseMode: appliedDecision.reuseMode,
              durationMs: measured(decisionMs),
              llmCalls: measured(0),
              costShare: estimated(totalMs > 0 ? Number((decisionMs / totalMs).toFixed(4)) : 0, "decisionMs/totalMs", 0.9),
            },
          }
        : {}),
      ...(status === "completed" || status === "reused"
        ? {}
        : { failure: { stage: status, reason: statusReason } }),
    };
    trace = security.redactDeep(trace);
    try {
      deps.traceSink?.(trace);
    } catch (error) {
      warnings.push(`trace sink failed (${errorText(error)})`);
    }
  }

  return {
    task: input.task,
    mode,
    requestedMode,
    ...(capped.reason ? { modeCapReason: capped.reason } : {}),
    policy: input.policy,
    category,
    status,
    statusReason,
    fingerprint,
    twin: {
      project: twin.project,
      modules: twin.modules.slice(0, 12),
      tests: twin.tests,
      build: twin.build,
      conventions: twin.conventions,
      preferredTools: twin.preferredTools,
      knownIssues: twin.knownIssues,
      relevantFiles,
      fileCount: facts.twinFacts.fileMap.length,
      facts: validationChecks.length > 0 ? observeValidation(projectFacts, validationChecks, finishedAt) : projectFacts,
    },
    experience: {
      similar: similar.map((s) => ({ task: s.record.task, status: s.record.status, similarity: s.similarity })),
      dialogueHits: context?.dialogueHits ?? 0,
    },
    context: {
      source: contextSource,
      anchors: contract.context.requiredAnchors,
      summaryLines: context?.summary.length ?? 0,
      ...(context?.compressedTokens !== undefined ? { compressedTokens: context.compressedTokens } : {}),
      ...(contextError ? { error: contextError } : {}),
    },
    verdicts,
    rawDecision,
    appliedDecision,
    tools,
    ...(costChoice ? { costChoice: { ...(costChoice.chosen ? { chosen: costChoice.chosen.id } : {}), rejected: costChoice.rejected } } : {}),
    harness: { complexity, budgetMs, maxRounds, dynamic: dynamicHarness },
    security: securityDecision,
    ...(writeAudit ? { writeAudit } : {}),
    contract,
    contractViolations,
    ...(harnessResult || status === "reused"
      ? {
          execution: {
            rounds: harnessResult?.rounds ?? 0,
            durationMs: harnessResult?.durationMs ?? 0,
            agentInvocations,
            validation: validationChecks,
            ...(harnessResult?.stopReason ? { stopReason: harnessResult.stopReason } : {}),
            ...(output !== undefined ? { output } : {}),
          },
        }
      : {}),
    reflections,
    ...(appliedPolicyVersion !== undefined ? { policyVersion: appliedPolicyVersion } : {}),
    record: decisionRecord,
    events: events.events(),
    warnings,
    ...(trace ? { trace } : {}),
    durationMs: totalMs,
  };
}

/**
 * Spec §9 "Agent down → fail-open to the native worker": if the efficiency
 * layer itself throws, re-run the task on the baseline path (no GraphFlow,
 * no caches, no learning) so the operator's task is not lost. Advisory runs
 * have nothing to fall back to and rethrow.
 */
export async function runPipelineFailOpen(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  try {
    return await runEfficiencyPipeline(input, deps);
  } catch (error) {
    if (input.mode === "advisory" || input.mode === "baseline") throw error;
    const reason = `efficiency layer failed: ${errorText(error)}`;
    const nullKv: KVStore = { get: () => undefined, set: () => undefined };
    const { fetchContext: _drop, ...rest } = deps;
    void _drop;
    const result = await runEfficiencyPipeline(
      { ...input, mode: "baseline" },
      {
        ...rest,
        cacheStore: nullKv,
        policyKv: nullKv,
        toolStore: nullKv,
        experience: { read: () => [], append: () => undefined },
      }
    );
    return { ...result, failOpen: { reason }, warnings: [reason, ...result.warnings] };
  }
}
