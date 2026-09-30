import type { Measurement } from "./measurement.js";

/**
 * P2–P7 shared contracts (2.x plan). Type-only. ORCHESTRATOR-OWNED: parallel
 * implementation agents import from here but NEVER edit this file — the file
 * domains are exclusive, and this file is outside every agent's domain.
 *
 * Area ownership:
 *   P3 fingerprint/caches/reuse-gate  → src/fingerprint.ts, src/reuse-gate.ts, src/caches/*
 *   P2 broker/workers                 → src/broker.ts, src/workers/*
 *   P4 trajectory/policy learning     → src/learning/*
 *   P5 project twin / tool registry   → src/project-twin.ts, src/tools/*
 *   P6 cost model / optimizer         → src/cost/*
 *   P7 reflection / self-optimize     → src/self-optimize/*
 */

// ───────────────── P3: fingerprint (plan §8, four tracks) ─────────────────

export interface ProjectStateFacts {
  gitHead?: string;
  workingTreeHash?: string;
  relevantFileHashes: Record<string, string>;
  dependencyLockHash?: string;
}

export interface ContextStateFacts {
  graphVersion?: string;
  contextPolicyVersion?: string;
  workingSetHash?: string;
}

export interface EnvironmentStateFacts {
  toolVersions: Record<string, string>;
  runtimeVersion?: string;
  selectedProvider?: string;
  dynamicStateFingerprint?: string;
}

export interface TaskFingerprint {
  semanticTaskHash: string;
  projectStateHash: string;
  contextStateHash: string;
  environmentStateHash: string;
  /** All four tracks joined — the reuse engine's primary key. */
  reuseKey: string;
}

// ───────────────── P3: cache verdicts + reuse gate ─────────────────

export type CacheKind = "context" | "plan" | "result";

export interface CacheVerdict {
  kind: CacheKind;
  hit: boolean;
  /** Machine-readable miss/invalidation reason ("ttl-expired", "project-state-changed", ...). */
  reason: string;
  fingerprintMatch: boolean;
  entryAgeMs?: number;
}

export interface ReuseDecision {
  reuseMode: "REUSE" | "ADAPT" | "FRESH";
  confidence: number;
  verdicts: CacheVerdict[];
  /** One line per contributing rule, human-readable. */
  rationale: string[];
}

/** Categories where a cached RESULT may be replayed (plan §7: conservative). */
export type ResultSafeCategory = "query" | "docs" | "config";

// ───────────────── P2: worker adapter + broker (plan §16) ─────────────────

export interface WorkerCommand {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface WorkerObservation {
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
  durationMs: number;
}

export interface ValidationOutcome {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean }>;
}

/**
 * Standard Worker Adapter (plan §16): prepare → execute → observe → validate
 * → stop. `execute` returns observations; `stop` must be safe to call at any
 * time, including after completion.
 */
export interface WorkerAdapter {
  name: string;
  prepare(validation: string[]): Promise<WorkerCommand | undefined>;
  execute(command: WorkerCommand): Promise<WorkerObservation>;
  validate(observation: WorkerObservation): Promise<ValidationOutcome>;
  stop(): Promise<void>;
}

export interface BrokerPolicy {
  maxRounds: number;
  totalBudgetMs: number;
  stopOnValidationPass: boolean;
}

export interface BrokerResult {
  status: "completed" | "failed" | "budget-exhausted" | "stopped";
  rounds: number;
  totalDurationMs: number;
  observations: WorkerObservation[];
  validation?: ValidationOutcome;
  stopReason?: string;
}

// ───────────────── P4: policy learning output ─────────────────

export interface PolicyUpdate {
  version: number;
  /** Minimum trajectory samples before a category's stats may drive changes. */
  minSamples: number;
  modelTierByCategory: Record<string, "economy" | "standard" | "heavy">;
  executionModeByCategory: Record<string, "one-shot" | "loop">;
  avoidPatterns: string[];
  /** One line per applied change; empty rationale means "no change". */
  rationale: string[];
}

// ───────────────── P6: cost model + optimizer (plan §20) ─────────────────

export interface CostBreakdown {
  components: Measurement[];
  /** Sum of components; provenance is the WEAKEST of the inputs (R5). */
  total: Measurement;
}

export interface CostFloor {
  minSuccessRate?: number;
  minFidelity?: number;
  minSafety?: number;
  minEvidence?: number;
}

export interface ActionCandidate {
  id: string;
  cost: Measurement;
  expectedSuccessRate: number;
  expectedFidelity: number;
  safety: number;
  evidence: number;
}

export interface OptimizerDecision {
  chosen?: ActionCandidate;
  rejected: Array<{ id: string; reason: string }>;
}

// ───────────────── P7: reflection + self-optimize cycle (plan §21) ─────────────────

export type ReflectionKind =
  | "cache-win"
  | "cache-miss"
  | "over-budget"
  | "quality-floor-miss"
  | "model-tier-escalation";

export interface ReflectionFinding {
  kind: ReflectionKind;
  detail: string;
}

export interface SelfOptimizeCycleInput {
  task: string;
  taskCategory: string;
  fingerprint: TaskFingerprint;
  reuse: ReuseDecision;
  policy: PolicyUpdate;
  /** Optional execution result when the cycle included a brokered run. */
  result?: BrokerResult;
  totalDurationMs: number;
  budgetMs: number;
}

export interface CycleOutcome {
  decision: ReuseDecision;
  reflections: ReflectionFinding[];
  policyUpdates: PolicyUpdate[];
}
