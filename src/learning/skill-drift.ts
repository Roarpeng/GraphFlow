import { cosineSimilarity, isHashFingerprint } from "./embeddings";
import { logger } from "../utils/logger";

/**
 * Semantic drift detection for skills (growth-plan §2.1 companion to the
 * deterministic symbol check in skill-staleness.ts).
 *
 * Symbol resolution answers "does the code the skill points at still exist?".
 * It cannot answer "does the code still MEAN what the skill says?": a symbol
 * can keep its name while its role changes entirely (a rename in reverse).
 * Drift closes that gap by comparing the skill's own descriptive text against
 * the CURRENT summaries of the symbols it is grounded in, in embedding space.
 *
 * Design constraints inherited from skill-staleness:
 * - failure-safe: any embedding error means "not drifted" — an infrastructure
 *   failure is not evidence the skill drifted, exactly like `lookup-error`;
 * - zero-cost offline: without a semantic provider (hash / missing
 *   fingerprint) the check reports `skipped` and nothing changes, so default
 *   and offline configurations behave identically to before this module.
 */

/**
 * Default cosine-distance threshold. 0.35 sits comfortably above the distance
 * a small embedding model produces for honest rewordings of one topic
 * (~0.1-0.25 for bge-family models) while still firing when the symbol side
 * describes a different concept entirely (~0.5+). Tunable via
 * `ComputeSkillDriftOptions.threshold` for experiments — no env var, this is
 * a research knob, not a user-facing setting.
 */
export const SKILL_DRIFT_DEFAULT_THRESHOLD = 0.35;

/**
 * Embedding provider seam. Structural subset of `EmbeddingProvider`
 * (learning/embeddings.ts) — any real provider is assignable, and tests can
 * supply deterministic mocks.
 */
export interface DriftEmbeddingProvider {
  embed(text: string): Promise<number[]>;
  /**
   * Model identity of the backing model. A missing fingerprint or an FNV-1a
   * hash fingerprint (`fnv1a-<dim>`) means "no semantic model" — the check is
   * skipped rather than lied to.
   */
  fingerprint?(): string | undefined;
}

/** The descriptive part of a skill that drift is measured against. */
export interface DriftSkillText {
  /** Skill name — for learned atoms the name *is* the extracted symbol. */
  name?: string;
  /** SkillOpt-lite guidance (`- bullet` lines). */
  guidance?: string;
}

/** Why the check did not run (reported instead of a fabricated distance). */
export type SkillDriftSkipReason =
  | "hash-or-missing-provider"
  | "embedding-error"
  | "no-text"
  | "incomparable-vectors";

export interface SkillDriftResult {
  /** True only when distance >= threshold AND the check actually ran. */
  drifted: boolean;
  /** Cosine distance in [0, 2]; -1 whenever the check was skipped. */
  distance: number;
  /** Threshold actually applied (default 0.35). */
  threshold: number;
  /** Present whenever the check could not run — never together with drifted. */
  skipped?: SkillDriftSkipReason;
}

export interface ComputeSkillDriftOptions {
  /** Cosine-distance threshold; defaults to SKILL_DRIFT_DEFAULT_THRESHOLD. */
  threshold?: number;
}

/** Build drift options under exactOptionalPropertyTypes (no explicit undefined). */
export function toComputeSkillDriftOptions(threshold: number | undefined): ComputeSkillDriftOptions {
  return threshold !== undefined ? { threshold } : {};
}

/** Cap on the skill-side text: local ONNX encoders truncate long inputs. */
const SKILL_TEXT_MAX_CHARS = 2000;
/** Cap per symbol summary, for the same reason. */
const SYMBOL_SUMMARY_MAX_CHARS = 2000;

/**
 * The skill's descriptive text: name plus guidance bullets, bullet markers
 * stripped, bounded in length. Bounded because transformer encoders silently
 * truncate past their context window — an unbounded string would compare
 * against only its invisible prefix.
 */
export function skillDriftText(skill: DriftSkillText): string {
  const lines = [skill.name ?? "", ...(skill.guidance ?? "").split("\n")]
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);
  return lines.join("\n").slice(0, SKILL_TEXT_MAX_CHARS);
}

function meanOfVectors(vectors: readonly number[][]): number[] {
  const dim = vectors[0]?.length ?? 0;
  const mean = new Array<number>(dim).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i += 1) {
      mean[i] = (mean[i] ?? 0) + (vector[i] ?? 0);
    }
  }
  for (let i = 0; i < dim; i += 1) {
    mean[i] = (mean[i] ?? 0) / vectors.length;
  }
  return mean;
}

function isZeroVector(vector: readonly number[]): boolean {
  for (const value of vector) {
    if (value !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Compare a skill's descriptive text with the current summaries of the
 * symbols it is grounded in.
 *
 * Symbol side design — MEAN OF EMBEDDINGS (centroid), not embedding of the
 * concatenation: (1) each grounded symbol contributes equal weight regardless
 * of how verbose its summary is, and (2) a concatenation silently truncates
 * past the encoder's context window, so later symbols would vanish from the
 * comparison; per-summary embeddings cannot. The centroid is order-invariant
 * up to float dust (callers pass summaries in deterministic symbol order).
 *
 * Everything is failure-safe: gate on a non-hash provider fingerprint, and
 * any embed() rejection is logged and reported as not drifted.
 */
export async function computeSkillDrift(
  skill: DriftSkillText,
  symbolSummaries: readonly string[],
  embeddingProvider: DriftEmbeddingProvider,
  options?: ComputeSkillDriftOptions
): Promise<SkillDriftResult> {
  const threshold =
    typeof options?.threshold === "number" && Number.isFinite(options.threshold)
      ? options.threshold
      : SKILL_DRIFT_DEFAULT_THRESHOLD;

  // Provider gate: hash fingerprints (fnv1a-*) and missing fingerprints carry
  // no semantic model — a hash distance would be pure noise. Offline/default
  // configurations therefore get zero behavior change from this module.
  const fingerprint = embeddingProvider.fingerprint?.();
  if (!fingerprint || isHashFingerprint(fingerprint)) {
    return { drifted: false, distance: -1, threshold, skipped: "hash-or-missing-provider" };
  }

  const skillText = skillDriftText(skill);
  const summaries = symbolSummaries
    .map((summary) => summary.trim().slice(0, SYMBOL_SUMMARY_MAX_CHARS))
    .filter((summary) => summary.length > 0);
  if (skillText.trim().length === 0 || summaries.length === 0) {
    return { drifted: false, distance: -1, threshold, skipped: "no-text" };
  }

  try {
    const [skillVector, ...symbolVectors] = await Promise.all([
      embeddingProvider.embed(skillText),
      ...summaries.map((summary) => embeddingProvider.embed(summary)),
    ]);
    if (
      !Array.isArray(skillVector) ||
      skillVector.length === 0 ||
      symbolVectors.some((vector) => !Array.isArray(vector) || vector.length !== skillVector.length)
    ) {
      return { drifted: false, distance: -1, threshold, skipped: "incomparable-vectors" };
    }
    const centroid = meanOfVectors(symbolVectors);
    if (isZeroVector(skillVector) || isZeroVector(centroid)) {
      return { drifted: false, distance: -1, threshold, skipped: "incomparable-vectors" };
    }
    const distance = 1 - cosineSimilarity(skillVector, centroid);
    return { drifted: distance >= threshold, distance, threshold };
  } catch (error) {
    logger.warn({ error }, "Skill semantic-drift check skipped after embedding failure");
    return { drifted: false, distance: -1, threshold, skipped: "embedding-error" };
  }
}
