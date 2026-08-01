import type { GraphEdge } from "../core/types";

/**
 * P0-2 outcome taxonomy for learned skills. Replaces the single pass/fail score
 * semantics with a four-way classification:
 *
 * - proven:      symbol evidence + enough observations (>= 2 uses or a linked
 *                successful outcome). Only this class accrues positive score.
 * - correctable: symbol evidence present but not yet proven. Never sinks score.
 * - anti-pattern: repeated failures with symbol evidence. The ONLY class that
 *                accrues negative score.
 * - noise:       no symbol evidence (generic bare tokens like "update"/"readme").
 *                Never persisted as a node; pruned on load if already present.
 */
export type SkillOutcomeKind = "proven" | "correctable" | "anti-pattern" | "noise";

export interface SkillState {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
  /** Soft-hidden from insights/hints after pruneFailedSkills (toxic fail streak). */
  hidden?: boolean;
  lastDecayedAt?: number;
  /** Extraction gate: candidate referenced project symbols (file/function/class paths). */
  hasSymbolEvidence?: boolean;
  /** A successful outcome linked to this skill via the episode outcome loop. */
  linkedSuccess?: boolean;
  /** Consecutive failure count; classified anti-pattern at >= 2. */
  failStreak?: number;
  /** Curated baseline written by seedInitialSkills — never pruned as noise. */
  seeded?: boolean;
  /** Outcome taxonomy classification (persisted for observability). */
  outcomeKind?: SkillOutcomeKind;
}

export interface CompositeSkillState {
  id: string;
  name: string;
  parents: [string, string];
  coOccurCount: number;
  successCount: number;
  failureCount: number;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
  /** Extraction gate: candidate referenced project symbols. */
  hasSymbolEvidence?: boolean;
  /** Curated baseline written by seedInitialSkills — never pruned as noise. */
  seeded?: boolean;
  /** Outcome taxonomy classification (persisted for observability). */
  outcomeKind?: SkillOutcomeKind;
}

export type EdgeRelation = GraphEdge["relation"];
export type SkillEdge = { from: string; to: string; relation: EdgeRelation };

export const DEFAULT_COMPOSITE_MIN_COOCCUR = 2;
export const DEFAULT_COMPOSITE_MIN_SUCCESS = 2;
