import { createHash } from "node:crypto";
import type { PolicyUpdate } from "../domain.js";
import { createPolicyStore, type KVStore } from "./policy-store.js";

/**
 * Safe self-learning lifecycle (spec §15): Outcome → Evidence Gate →
 * Candidate → Shadow → Canary → Production, with Proven (promoted) and
 * Anti-pattern (rejected in canary) outcomes; rollback per §24.
 *
 * At most one policy is in flight (shadow or canary). Production lives in the
 * policy store's own keys and is only ever written through
 * `createPolicyStore(store).apply`, so versions stay monotonic. Lifecycle
 * state is a single JSON document under LIFECYCLE_KEY; a corrupt document is
 * read as "nothing staged" rather than throwing.
 */

export type PolicyStage = "candidate" | "shadow" | "canary" | "production" | "rejected";

export interface StagedPolicyEvidence {
  shadowRuns: number;
  shadowDisagreements: number;
  canaryRuns: number;
  canarySuccesses: number;
  baselineRuns: number;
  baselineSuccesses: number;
}

export interface StagedPolicy {
  update: PolicyUpdate;
  stage: PolicyStage;
  createdAt: number;
  evidence: StagedPolicyEvidence;
  history: Array<{ at: number; from: PolicyStage; to: PolicyStage; reason: string }>;
}

export interface PolicyLifecycleOptions {
  /** Shadow runs required before canary (default 5, minimum 1). */
  minShadowRuns?: number;
  /** Canary runs required before a promotion decision (default 5, minimum 1). */
  minCanaryRuns?: number;
  /** Share of tasks routed to the canary arm, 0..1 (default 0.2). */
  canaryFraction?: number;
}

export interface PolicyEvaluation {
  stage: PolicyStage | "none";
  promoted?: PolicyUpdate;
  reason: string;
}

export interface PolicyLifecycle {
  propose(update: PolicyUpdate, now: number): StagedPolicy;
  staged(): StagedPolicy | undefined;
  recordShadow(disagreesWithProduction: boolean): void;
  inCanary(taskId: string): boolean;
  recordOutcome(arm: "canary" | "baseline", success: boolean): void;
  evaluate(now: number): PolicyEvaluation;
  antiPatterns(): string[];
  production(): PolicyUpdate | undefined;
  rollback(): PolicyUpdate | undefined;
}

export const LIFECYCLE_KEY = "policy-lifecycle";

interface LifecycleState {
  staged?: StagedPolicy;
  antiPatterns: string[];
}

const emptyEvidence = (): StagedPolicyEvidence => ({
  shadowRuns: 0,
  shadowDisagreements: 0,
  canaryRuns: 0,
  canarySuccesses: 0,
  baselineRuns: 0,
  baselineSuccesses: 0,
});

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isStagedPolicy = (value: unknown): value is StagedPolicy => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<StagedPolicy>;
  const evidence = v.evidence as Partial<StagedPolicyEvidence> | undefined;
  return (
    typeof v.update === "object" &&
    v.update !== null &&
    typeof v.update.version === "number" &&
    (v.stage === "shadow" || v.stage === "canary") &&
    typeof v.createdAt === "number" &&
    Array.isArray(v.history) &&
    typeof evidence === "object" &&
    evidence !== null &&
    isCount(evidence.shadowRuns) &&
    isCount(evidence.shadowDisagreements) &&
    isCount(evidence.canaryRuns) &&
    isCount(evidence.canarySuccesses) &&
    isCount(evidence.baselineRuns) &&
    isCount(evidence.baselineSuccesses)
  );
};

/** Deterministic bucket in [0, 1) from the first 32 bits of sha256(taskId). */
export function canaryBucket(taskId: string): number {
  return createHash("sha256").update(taskId).digest().readUInt32BE(0) / 0x1_0000_0000;
}

const positiveInt = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));

export function createPolicyLifecycle(store: KVStore, options: PolicyLifecycleOptions = {}): PolicyLifecycle {
  const policyStore = createPolicyStore(store);
  const minShadowRuns = positiveInt(options.minShadowRuns, 5);
  const minCanaryRuns = positiveInt(options.minCanaryRuns, 5);
  const canaryFraction =
    options.canaryFraction === undefined || !Number.isFinite(options.canaryFraction)
      ? 0.2
      : Math.min(1, Math.max(0, options.canaryFraction));

  const read = (): LifecycleState => {
    const raw = store.get(LIFECYCLE_KEY);
    if (raw === undefined) return { antiPatterns: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { antiPatterns: [] };
    }
    if (typeof parsed !== "object" || parsed === null) return { antiPatterns: [] };
    const candidate = parsed as { staged?: unknown; antiPatterns?: unknown };
    const antiPatterns = Array.isArray(candidate.antiPatterns)
      ? candidate.antiPatterns.filter((item): item is string => typeof item === "string")
      : [];
    return isStagedPolicy(candidate.staged) ? { staged: candidate.staged, antiPatterns } : { antiPatterns };
  };

  const write = (state: LifecycleState): void => {
    store.set(LIFECYCLE_KEY, JSON.stringify(state));
  };

  const transition = (policy: StagedPolicy, to: PolicyStage, at: number, reason: string): StagedPolicy => ({
    ...policy,
    stage: to,
    history: [...policy.history, { at, from: policy.stage, to, reason }],
  });

  const rejectAsAntiPattern = (state: LifecycleState, staged: StagedPolicy, reason: string): PolicyEvaluation => {
    const antiPatterns = Array.from(new Set([...state.antiPatterns, ...staged.update.rationale]));
    write({ antiPatterns });
    return { stage: "rejected", reason };
  };

  return {
    propose(update, now) {
      const productionVersion = policyStore.current()?.version ?? 0;
      const gateFailures: string[] = [];
      if (update.rationale.every((line) => line.trim().length === 0)) {
        gateFailures.push("empty rationale (no evidence of change)");
      }
      if (!Number.isInteger(update.version) || update.version < 1) {
        gateFailures.push(`version must be a positive integer, got ${String(update.version)}`);
      } else if (update.version <= productionVersion) {
        gateFailures.push(`version ${update.version} <= production version ${productionVersion}`);
      }
      const candidate: StagedPolicy = {
        update,
        stage: "candidate",
        createdAt: now,
        evidence: emptyEvidence(),
        history: [],
      };
      if (gateFailures.length > 0) {
        return transition(candidate, "rejected", now, `evidence gate: ${gateFailures.join("; ")}`);
      }
      const state = read();
      const superseded = state.staged
        ? ` (supersedes in-flight v${state.staged.update.version} in ${state.staged.stage})`
        : "";
      const shadow = transition(candidate, "shadow", now, `evidence gate passed${superseded}`);
      write({ ...state, staged: shadow });
      return shadow;
    },

    staged() {
      return read().staged;
    },

    recordShadow(disagreesWithProduction) {
      const state = read();
      const staged = state.staged;
      if (staged?.stage !== "shadow") return;
      staged.evidence.shadowRuns += 1;
      if (disagreesWithProduction) staged.evidence.shadowDisagreements += 1;
      write(state);
    },

    inCanary(taskId) {
      if (read().staged?.stage !== "canary") return false;
      return canaryBucket(taskId) < canaryFraction;
    },

    recordOutcome(arm, success) {
      const state = read();
      const staged = state.staged;
      if (staged?.stage !== "canary") return;
      if (arm === "canary") {
        staged.evidence.canaryRuns += 1;
        if (success) staged.evidence.canarySuccesses += 1;
      } else {
        staged.evidence.baselineRuns += 1;
        if (success) staged.evidence.baselineSuccesses += 1;
      }
      write(state);
    },

    evaluate(now) {
      const state = read();
      const staged = state.staged;
      if (staged === undefined) return { stage: "none", reason: "no staged policy" };
      const e = staged.evidence;

      if (staged.stage === "shadow") {
        if (e.shadowRuns < minShadowRuns) {
          return { stage: "shadow", reason: `shadow ${e.shadowRuns}/${minShadowRuns} runs` };
        }
        const reason = `shadow complete: ${e.shadowRuns} runs, ${e.shadowDisagreements} disagreements with production`;
        write({ ...state, staged: transition(staged, "canary", now, reason) });
        return { stage: "canary", reason };
      }

      if (e.canaryRuns < minCanaryRuns || e.baselineRuns < 1) {
        return {
          stage: "canary",
          reason: `canary ${e.canaryRuns}/${minCanaryRuns} runs, baseline ${e.baselineRuns}/1 runs`,
        };
      }
      const rates = `canary ${e.canarySuccesses}/${e.canaryRuns} vs baseline ${e.baselineSuccesses}/${e.baselineRuns}`;
      // Cross-multiplied success-rate comparison: canary >= baseline (spec §28).
      if (e.canarySuccesses * e.baselineRuns < e.baselineSuccesses * e.canaryRuns) {
        return rejectAsAntiPattern(state, staged, `anti-pattern: ${rates}`);
      }
      let promoted: PolicyUpdate;
      try {
        promoted = policyStore.apply(staged.update);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        write({ antiPatterns: state.antiPatterns });
        return { stage: "rejected", reason: `promotion refused by policy store: ${message}` };
      }
      write({ antiPatterns: state.antiPatterns });
      return { stage: "production", promoted, reason: `proven: ${rates}` };
    },

    antiPatterns() {
      return read().antiPatterns;
    },

    production() {
      return policyStore.current();
    },

    rollback() {
      const restored = policyStore.rollback();
      write({ antiPatterns: read().antiPatterns });
      return restored;
    },
  };
}
