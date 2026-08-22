/**
 * Canary gate for team-memory skill promotion (P1).
 *
 * External (sync/import) skills must not enter `proven` until canary passes:
 * either N successful local applications, or an explicit validate hook.
 * Anti-patterns stay isolated (soft-hide / exclude from hints) — never deleted.
 */

import type { SkillOutcomeKind, SkillProvenance } from "./skill-types.js";
import { admitSkillToProven } from "./skill-admission.js";

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
  /** 绑定且 outcome=pass 的去重 episode 数（真实成功证据链，透传准入门）。 */
  successCount?: number;
  /** When set, proven is held at correctable unless the held-out admission gate passes. */
  skillName?: string;
}

/**
 * Gate proven promotion for external skills and the held-out admission gate.
 * Other classes pass through. Proven is held at correctable until canaryPassed
 * and (when skillName is provided) admitSkillToProven. Real success evidence
 * (successCount >= threshold) bypasses the golden-overlap veto inside the
 * admission gate — see skill-admission.
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
  if (!canaryPassed(check)) {
    return "correctable";
  }
  const admitOptions: { successCount?: number } | undefined =
    options.successCount !== undefined ? { successCount: options.successCount } : undefined;
  if (options.skillName && !admitSkillToProven(options.skillName, admitOptions).ok) {
    return "correctable";
  }
  return "proven";
}

/**
 * Anti-pattern isolation policy: never hard-delete. Soft-hide / exclude from
 * positive injection only so poisoned entries remain auditable.
 */
export function shouldHardDeleteAntiPattern(): false {
  return false;
}
