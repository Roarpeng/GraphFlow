/**
 * Evidence-confidence skill ranking + lesson dedup (Wilson lower bound).
 *
 * Research grounding: ranking by raw success rate lets a 2/2-success skill
 * outrank a 46/50 one — small samples have no confidence. The Wilson score
 * interval LOWER bound is the classic "sort by how confident we are the skill
 * is actually good" statistic (same family as Reddit's comment ranking):
 *
 *   LB = (p̂ + z²/2n − z·sqrt(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
 *
 * Skills with zero evidence (uses = 0) get LB = 0 and therefore sort after
 * every skill with positive evidence, deterministically (score → updatedAt →
 * id tie-breaks). This module is a leaf: it only depends on skill-types so
 * skill-flywheel / skill-opt-lite can consume it without cycles.
 */

import type { SkillState } from "./skill-types";

/** Default z for a ~95% one-sided confidence bound. */
export const WILSON_DEFAULT_Z = 1.96;

/** LB differences below this epsilon are treated as ties (float dust guard). */
const WILSON_EPSILON = 1e-12;

/**
 * Classic Wilson score interval lower bound for a binomial proportion.
 * Returns 0 when total <= 0 (no evidence → no confidence). `successes` is
 * clamped into [0, total].
 */
export function wilsonLowerBound(successes: number, total: number, z = WILSON_DEFAULT_Z): number {
  const n = Math.floor(total);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  const zz = Number.isFinite(z) && z > 0 ? z : WILSON_DEFAULT_Z;
  const z2 = zz * zz;
  const s = Number.isFinite(successes) ? Math.min(Math.max(Math.floor(successes), 0), n) : 0;
  const phat = s / n;
  const denominator = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = zz * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / denominator);
}

/**
 * Real success-evidence count for a skill — the same dual-evidence semantics
 * as the adaptive decay (max of persisted successCount, deduped episode ids,
 * and the legacy linkedSuccess+episodeId migration), but UNCAPPED: ranking
 * must keep distinguishing 46/50 from 6/6.
 */
export function skillSuccessEvidence(state: SkillState): number {
  const persisted =
    typeof state.successCount === "number" && Number.isFinite(state.successCount)
      ? Math.max(0, Math.floor(state.successCount))
      : 0;
  const episodeSuccesses = Array.isArray(state.successEpisodeIds)
    ? new Set(state.successEpisodeIds.filter(Boolean)).size
    : 0;
  const legacy = state.linkedSuccess === true && state.provenance?.episodeId ? 1 : 0;
  return Math.max(persisted, episodeSuccesses, legacy);
}

/** Wilson LB of a skill's (success evidence, uses) binomial. */
export function skillStateWilsonLB(state: SkillState): number {
  return wilsonLowerBound(skillSuccessEvidence(state), Math.max(0, state.uses));
}

/**
 * Rank atomic skill states for recall/listing:
 *  1. Wilson LB of (success evidence, uses) — descending.
 *  2. tie: existing heuristic `score` — descending.
 *  3. tie: `updatedAt` — descending (fresher first).
 *  4. tie: `id` ascending (deterministic total order).
 *
 * Returns a new array; the input is not mutated.
 */
export function rankSkillStates(skills: SkillState[]): SkillState[] {
  return skills
    .map((skill) => ({ skill, lb: skillStateWilsonLB(skill) }))
    .sort((a, b) => {
      const lbDiff = b.lb - a.lb;
      if (Math.abs(lbDiff) > WILSON_EPSILON) {
        return lbDiff;
      }
      if (b.skill.score !== a.skill.score) {
        return b.skill.score - a.skill.score;
      }
      if (b.skill.updatedAt !== a.skill.updatedAt) {
        return b.skill.updatedAt - a.skill.updatedAt;
      }
      return a.skill.id.localeCompare(b.skill.id);
    })
    .map((entry) => entry.skill);
}

// ── Lessons dedup ────────────────────────────────────────────────────────

/** Tokenizer stopword set for near-dup detection (English glue words only). */
const LESSON_DEDUP_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "it", "this", "that", "as", "at",
  "from", "not", "but", "do", "done",
]);

/** Near-duplicate threshold on token-set Jaccard similarity. */
export const LESSON_NEAR_DUP_JACCARD = 0.8;

/** Normalize a lesson for exact-dup keys: bullet prefix + case + whitespace. */
function normalizeLessonText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[-*•]\s+/, "")
    .replace(/\s+/g, " ");
}

/**
 * Content token set of a lesson: lowercase word/CJK-run tokens with English
 * stopwords removed, so "word-order changes" and "added stopword" variants
 * collapse to (nearly) the same set.
 */
function lessonTokenSet(text: string): Set<string> {
  const tokens = normalizeLessonText(text)
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length > 0 && !LESSON_DEDUP_STOPWORDS.has(token));
  return new Set(tokens);
}

/** Jaccard similarity of two token sets; 0 when both are empty (no signal). */
function tokenSetJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Dedup lessons before they accumulate into playbook guidance / episode
 * records: exact-normalized duplicates and token-set Jaccard >= 0.8
 * near-duplicates collapse onto their FIRST (earliest) occurrence; input
 * order is otherwise preserved. Empty/whitespace-only entries are dropped.
 */
export function dedupLessons(lessons: string[]): string[] {
  const seenNorms = new Set<string>();
  const seenTokenSets: Array<Set<string>> = [];
  const out: string[] = [];
  for (const raw of lessons) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const norm = normalizeLessonText(trimmed);
    if (!norm || seenNorms.has(norm)) {
      continue;
    }
    const tokens = lessonTokenSet(trimmed);
    let nearDup = false;
    for (const previous of seenTokenSets) {
      if (tokenSetJaccard(tokens, previous) >= LESSON_NEAR_DUP_JACCARD) {
        nearDup = true;
        break;
      }
    }
    if (nearDup) {
      continue;
    }
    seenNorms.add(norm);
    seenTokenSets.push(tokens);
    out.push(trimmed);
  }
  return out;
}
