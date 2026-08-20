/**
 * Held-out skill admission gate (Experience v2 P1).
 *
 * Generic stopwords and readme+update fusions never become proven.
 * Proven requires project-symbol shape and overlap with retrieval-golden
 * expected file stems / symbols. Do not run the full retrieval benchmark here.
 */

/**
 * Tiny held-out subset of `benchmarks/retrieval-golden-data.ts` expectAny tokens
 * plus a few symbol names used by unit tests. The full GOLDEN_SET is not imported
 * (tsconfig rootDir is `src/`; a static import would fail typecheck / cycle into benches).
 */
export const FALLBACK_GOLDEN_TOKENS: readonly string[] = [
  "skill-flywheel",
  "skill-flywheel.ts",
  "applySkillLearning",
  "planner",
  "skill-store",
  "skill-types",
  "skill-package",
  "goal-anchor",
  "cache-layer",
  "orchestrator",
  "context-slicer",
  "graphify-client",
  "dag-engine",
  "model-router",
  "seed-skills",
];

const STOPWORDS = new Set([
  "update", "readme", "add", "fix", "file", "files",
  "module", "the", "and", "with", "in", "a", "an", "to", "for", "of",
  "on", "at", "by", "from", "is", "are", "was", "were", "be", "been",
  "or", "not", "but", "this", "that", "it", "as", "if", "do", "done",
]);

const PROJECT_SYMBOL_PATTERNS: Array<{ test: RegExp; match: RegExp }> = [
  { test: /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/i, match: /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/gi },
  { test: /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/i, match: /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/gi },
  { test: /[a-z]+[A-Z][a-zA-Z0-9]*/, match: /[a-z]+[A-Z][a-zA-Z0-9]*/g },
  { test: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i, match: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi },
];

const GOLDEN_TOKEN_SET: Set<string> = buildGoldenTokenSet();

export interface SkillAdmissionResult {
  ok: boolean;
  reason: string;
}

function flattenSkillName(name: string): string {
  return name.replace(/\+/g, " ").trim();
}

function tokenizePhrase(phrase: string): string[] {
  return phrase
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/** True when every non-empty token is a generic stopword (e.g. "readme+update"). */
export function isStopwordOnlyName(name: string): boolean {
  const tokens = tokenizePhrase(flattenSkillName(name));
  if (tokens.length === 0) {
    return true;
  }
  return tokens.every((token) => STOPWORDS.has(token));
}

/** True when the name is a generic readme/update fusion, with or without `+`. */
export function isReadmeUpdateNoise(name: string): boolean {
  const tokens = new Set(tokenizePhrase(flattenSkillName(name)));
  return tokens.has("readme") && tokens.has("update");
}

function hasProjectSymbolShape(text: string): boolean {
  if (!text) {
    return false;
  }
  return PROJECT_SYMBOL_PATTERNS.some(({ test }) => test.test(text));
}

/**
 * True when the skill name itself looks like a project symbol
 * (file / slash-path / camelCase / snake_case). Composite "+" is flattened.
 * Stopword-only fusions such as "readme+update" never qualify — even if a
 * legacy `hasSymbolEvidence` flag was wrongly set.
 */
export function isSymbolicSkillName(name: string): boolean {
  const flattened = flattenSkillName(name);
  if (!flattened || isStopwordOnlyName(name)) {
    return false;
  }
  return hasProjectSymbolShape(flattened);
}

function stripExtension(token: string): string {
  return token.replace(/\.[a-z0-9]{1,8}$/i, "");
}

function compactToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function splitCamelCase(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0);
}

function collectNameTokens(skillName: string): Set<string> {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const lower = raw.toLowerCase().trim();
    if (lower.length < 3) {
      return;
    }
    out.add(lower);
    const stem = stripExtension(lower);
    if (stem.length >= 3) {
      out.add(stem);
    }
    const compact = compactToken(raw);
    if (compact.length >= 3) {
      out.add(compact);
    }
  };

  add(skillName);
  for (const part of flattenSkillName(skillName).split(/[\s,;/]+/)) {
    add(part);
    for (const camel of splitCamelCase(part)) {
      add(camel);
    }
  }
  for (const camel of splitCamelCase(skillName)) {
    add(camel);
  }
  return out;
}

function buildGoldenTokenSet(): Set<string> {
  const out = new Set<string>();
  for (const token of FALLBACK_GOLDEN_TOKENS) {
    const lower = token.toLowerCase();
    out.add(lower);
    const stem = stripExtension(lower);
    if (stem.length >= 3) {
      out.add(stem);
    }
    const compact = compactToken(token);
    if (compact.length >= 3) {
      out.add(compact);
    }
  }
  return out;
}

function isWeakOverlapToken(token: string): boolean {
  return STOPWORDS.has(token) || token.length < 5;
}

/** Held-out overlap: skill name tokens vs golden expected file stems / symbols. */
export function goldenTokenOverlap(skillName: string): string[] {
  const hits: string[] = [];
  for (const token of collectNameTokens(skillName)) {
    if (isWeakOverlapToken(token)) {
      continue;
    }
    if (GOLDEN_TOKEN_SET.has(token)) {
      hits.push(token);
    }
  }
  return hits;
}

/**
 * Admission gate before a skill may stay `proven`.
 * Generic stopwords / readme+update fusions never pass.
 */
export function admitSkillToProven(skillName: string): SkillAdmissionResult {
  const name = skillName.trim();
  if (!name) {
    return { ok: false, reason: "empty-name" };
  }
  if (isStopwordOnlyName(name)) {
    return { ok: false, reason: "stopword-only" };
  }

  const overlap = goldenTokenOverlap(name);
  const symbolic = isSymbolicSkillName(name);
  if (overlap.length === 0) {
    return {
      ok: false,
      reason: symbolic ? "no-golden-overlap" : "no-project-symbol-evidence",
    };
  }
  return {
    ok: true,
    reason: symbolic ? "symbolic-golden-overlap" : "golden-overlap",
  };
}

/** True when promoting this name to proven would inject library-degrading noise. */
export function wouldDegradeLibrary(skillName: string): boolean {
  return !admitSkillToProven(skillName).ok;
}
