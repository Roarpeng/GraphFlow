/**
 * Canary gate for team-memory skill promotion (P1).
 *
 * External (sync/import) skills must not enter `proven` until canary passes:
 * either N successful local applications, or an explicit validate hook.
 * Anti-patterns stay isolated (soft-hide / exclude from hints) — never deleted.
 */

import type { SkillOutcomeKind, SkillProvenance } from "./skill-types.js";

/** Successful local uses required before an external skill may become proven. */
export const DEFAULT_CANARY_LOCAL_SUCCESSES = 2;

export function isExternalSkillSource(provenance?: SkillProvenance): boolean {
  const source = provenance?.source ?? "local";
  return source === "sync" || source === "import";
}

export interface CanaryCheckInput {
  provenance?: SkillProvenance;
  /** Count of successful local applications (typically uses after pass outcomes). */
  localSuccesses: number;
  /** Explicit validate hook — bypasses the local-success threshold. */
  validated?: boolean;
  minLocalSuccesses?: number;
}

/** True when the skill is allowed to promote to proven under the canary policy. */
export function canaryPassed(input: CanaryCheckInput): boolean {
  if (!isExternalSkillSource(input.provenance)) {
    return true;
  }
  if (input.validated === true) {
    return true;
  }
  const need = input.minLocalSuccesses ?? DEFAULT_CANARY_LOCAL_SUCCESSES;
  return input.localSuccesses >= need;
}

export interface GateSkillPromotionOptions {
  outcomeKind: SkillOutcomeKind;
  provenance?: SkillProvenance;
  localSuccesses: number;
  validated?: boolean;
  minLocalSuccesses?: number;
}

/**
 * Gate proven promotion for external skills. Other classes pass through.
 * Proven is held at correctable until canaryPassed.
 */
export function gateSkillPromotion(options: GateSkillPromotionOptions): SkillOutcomeKind {
  if (options.outcomeKind !== "proven") {
    return options.outcomeKind;
  }
  const check: CanaryCheckInput = {
    localSuccesses: options.localSuccesses,
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.validated !== undefined ? { validated: options.validated } : {}),
    ...(options.minLocalSuccesses !== undefined
      ? { minLocalSuccesses: options.minLocalSuccesses }
      : {}),
  };
  return canaryPassed(check) ? "proven" : "correctable";
}

/**
 * Anti-pattern isolation policy: never hard-delete. Soft-hide / exclude from
 * positive injection only so poisoned entries remain auditable.
 */
export function shouldHardDeleteAntiPattern(): false {
  return false;
}
