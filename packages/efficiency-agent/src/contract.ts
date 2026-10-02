/**
 * Execution Contract v1 — the normative type the Efficiency Agent emits and
 * the substrate's `graphflow_run` advisory already implements. It is a
 * SUPERSET evolution of the substrate's executionDescriptor, not a second
 * schema: descriptor fields (task, context, steps) stay where they are; the
 * contract adds the efficiency verdicts (reuse/model/execution/validation)
 * and the decision's own cost.
 *
 * Boundary rule: this package never reads GraphFlow's SQLite/files. It
 * consumes the MCP response JSON (`advisory` block) and only asserts shape.
 */

export type ReuseMode = "REUSE" | "ADAPT" | "FRESH";
export type ModelTier = "economy" | "standard" | "heavy";
export type ExecutionMode = "one-shot" | "loop";

export interface ContractBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxRounds: number;
  maxWallMs: number;
}

export interface ContractPermissions {
  read: string[];
  write: string[];
  network: boolean;
}

export interface ExecutionContractV1 {
  schemaVersion: "1.0";
  taskId: string;
  /** Unique per decision (replay / rollback key, spec §24). */
  decisionId?: string;
  /** Evidence behind the reuse verdict (cache verdict reasons, similar episodes). */
  reuseEvidence?: string[];
  mode: "shadow" | "conservative" | "adaptive";
  reuseMode: ReuseMode;
  confidence: number;
  signals: {
    taskComplexity: "simple" | "complex";
    executionMode: "bridge" | "llm";
    fusedStepCount: number;
    similarEpisodeCount: number;
    topEpisodeScore?: number;
    /** Jaccard task similarity of the closest prior episode (0..1). */
    topEpisodeSimilarity?: number;
  };
  context: {
    source: "graphflow";
    requiredAnchors: string[];
    maxTokens?: number;
    cached?: boolean;
  };
  /** §5: project identity the fingerprint binds to (when known). */
  project?: {
    root: string;
    gitHead?: string;
    workingTreeHash?: string;
    graphVersion?: string;
    toolchainHash?: string;
  };
  /** §5: experience pointers the decision consumed. */
  experience?: {
    episodes: string[];
    topSimilarity?: number;
    skills?: string[];
    avoidPatterns?: string[];
  };
  /** §5: capability-based tool needs (selected by capability, not name). */
  tools?: Array<{ name: string; capability: string; risk?: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" }>;
  /** §21 closed loop: a learned policy overrode the deterministic hints. */
  policyApplied?: { version: number };
  worker: {
    modelTier: ModelTier;
    executionMode: ExecutionMode;
    maxRounds: number;
    provider?: string;
  };
  validation: string[];
  validationPolicy?: { required: boolean; evidenceRequired: boolean };
  budget?: ContractBudget;
  permissions?: ContractPermissions;
  decision: {
    provenance: "deterministic" | "llm";
    llmCalls: number;
    durationMs: number;
  };
}

const REUSE_MODES: readonly ReuseMode[] = ["REUSE", "ADAPT", "FRESH"];
const MODEL_TIERS: readonly ModelTier[] = ["economy", "standard", "heavy"];

/**
 * Accept a substrate advisory (parsed MCP JSON) as a contract. Returns
 * violations; empty array means the advisory is contract-complete and the
 * efficiency layer may act on it.
 */
export function assertAdvisoryCompatible(advisory: unknown): string[] {
  const violations: string[] = [];
  const fail = (msg: string): void => {
    violations.push(msg);
  };
  if (typeof advisory !== "object" || advisory === null) {
    return ["advisory: not an object"];
  }
  const a = advisory as Partial<ExecutionContractV1>;

  if (a.schemaVersion !== "1.0") fail("schemaVersion: expected \"1.0\"");
  if (typeof a.taskId !== "string" || a.taskId.length === 0) fail("taskId: non-empty string required");
  if (a.mode !== "shadow" && a.mode !== "conservative" && a.mode !== "adaptive") {
    fail("mode: shadow|conservative|adaptive required");
  }
  if (!REUSE_MODES.includes(a.reuseMode as ReuseMode)) fail("reuseMode: REUSE|ADAPT|FRESH required");
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) {
    fail("confidence: 0..1 required");
  }
  if (!a.signals || (a.signals.taskComplexity !== "simple" && a.signals.taskComplexity !== "complex")) {
    fail("signals.taskComplexity: simple|complex required");
  }
  if (!a.context || a.context.source !== "graphflow" || !Array.isArray(a.context.requiredAnchors)) {
    fail("context: source=graphflow and requiredAnchors[] required");
  }
  if (!a.worker || !MODEL_TIERS.includes(a.worker.modelTier as ModelTier)) {
    fail("worker.modelTier: economy|standard|heavy required");
  }
  if (!a.worker || (a.worker.executionMode !== "one-shot" && a.worker.executionMode !== "loop")) {
    fail("worker.executionMode: one-shot|loop required");
  }
  if (!a.worker || typeof a.worker.maxRounds !== "number" || a.worker.maxRounds < 1) {
    fail("worker.maxRounds: positive number required");
  }
  if (!Array.isArray(a.validation)) fail("validation: string[] required");
  if (a.project !== undefined && (typeof a.project.root !== "string" || a.project.root.length === 0)) {
    fail("project: non-empty root required when present");
  }
  if (a.experience !== undefined && !Array.isArray(a.experience.episodes)) {
    fail("experience: episodes[] required when present");
  }
  if (
    a.tools !== undefined &&
    (!Array.isArray(a.tools) ||
      a.tools.some((t) => typeof t?.name !== "string" || typeof t?.capability !== "string"))
  ) {
    fail("tools: {name, capability}[] required when present");
  }
  if (a.decisionId !== undefined && (typeof a.decisionId !== "string" || a.decisionId.length === 0)) {
    fail("decisionId: non-empty string required when present");
  }
  if (a.budget !== undefined) {
    for (const key of ["maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxRounds", "maxWallMs"] as const) {
      if (typeof a.budget[key] !== "number" || a.budget[key] < 0) fail(`budget.${key}: non-negative number required`);
    }
  }
  if (
    a.permissions !== undefined &&
    (!Array.isArray(a.permissions.read) || !Array.isArray(a.permissions.write) || typeof a.permissions.network !== "boolean")
  ) {
    fail("permissions: read[], write[] and network boolean required when present");
  }
  if (
    a.validationPolicy !== undefined &&
    (typeof a.validationPolicy.required !== "boolean" || typeof a.validationPolicy.evidenceRequired !== "boolean")
  ) {
    fail("validationPolicy: required and evidenceRequired booleans required when present");
  }
  if (a.validationPolicy?.required === true && Array.isArray(a.validation) && a.validation.length === 0) {
    fail("validationPolicy.required: at least one validation command required");
  }
  if (a.policyApplied !== undefined && typeof a.policyApplied.version !== "number") {
    fail("policyApplied: version number required when present");
  }
  if (!a.decision || typeof a.decision.llmCalls !== "number" || typeof a.decision.durationMs !== "number") {
    fail("decision: llmCalls and durationMs numbers required");
  }
  if (a.decision?.provenance !== "deterministic" && a.decision?.provenance !== "llm") {
    fail("decision.provenance: deterministic|llm required");
  }
  // Shadow v0 invariant: a deterministic decision bills zero LLM calls. If a
  // future layer makes model calls, it MUST declare provenance=llm — a
  // deterministic verdict that billed calls is a bookkeeping lie.
  if (a.decision?.provenance === "deterministic" && a.decision.llmCalls !== 0) {
    fail("decision: deterministic provenance must bill 0 llmCalls");
  }
  return violations;
}
