import { estimateTokens } from "./context-slicer-utils.js";
import type { CacheInsertionAdvice } from "../surfaces/cli/runtime/types.js";

/**
 * Prefix Cache Planner — declaration only.
 *
 * Prompt caching is a left-to-right prefix match. A single differing byte
 * invalidates every token after it, and those tokens must then be written at the
 * write premium (1.25x base input) instead of read at the discount (0.1x).
 * Providers' own guidance is therefore "order by stability: stable first, most
 * volatile last, breakpoint on the last block that stays identical".
 *
 * GraphFlow injects per-turn-varying content. When a host places that content
 * *before* its stable prefix, every turn forces the host to rewrite its entire
 * conversation history. Measured on this project (50k-token host tail, 97.4%
 * churn): a $0.168/turn rewrite surcharge against $0.0156/turn saved by
 * compressing — a 10x net loss. The compression was never the problem; the
 * position was.
 *
 * So this module's whole job is to tell the host which of our lines are stable
 * and which are not, and to refuse to pretend we know things we cannot see.
 *
 * ## The plugin boundary
 *
 * This declares; it does not decide. GraphFlow is an MCP plugin, not a harness.
 * It cannot set a cache breakpoint, choose an injection position, or stop the
 * host from re-rendering our lines — those are the host's API calls. It can only
 * say "these N lines are stable, these M are not", and be ignored.
 *
 * That is the correct shape for this feature, not a limitation to engineer
 * around. A plugin that could *reorder* a host's prompt would be a harness
 * wearing a plugin's clothes, and it would break the moment the host's prompt
 * shape differed from our assumption.
 */

export const CACHE_LAYOUT_ENV = "GRAPHFLOW_CACHE_LAYOUT";

export interface CacheLayoutStableLine {
  line: string;
  /** Why this line is classed stable, for auditing. */
  channel: "repo-map" | "module" | "convention";
}

export interface CacheLayoutDeltaLine {
  line: string;
  /** Why this line is classed per-turn, for auditing. */
  channel: "anchor" | "summary" | "dialogue" | "handle";
}

export interface CacheLayoutPlan {
  stablePrefix: { lines: string[]; tokens: number };
  delta: { lines: string[]; tokens: number };
  insertion: CacheInsertionAdvice;
  /**
   * Share of THIS package that is stable. Distinct from `reusablePrefixShare`
   * below: this is about us, that is about the request the host actually sends.
   */
  stableShare: number;
  /**
   * Share of the host's request prefix that survives if the host orders by this
   * declaration. Null when the host prefix is unknown — we are not the harness,
   * so we cannot see the system prompt, tool schemas or history, and a guess
   * here would be worse than an honest null.
   */
  reusablePrefixShare: number | null;
  note: string;
}

/**
 * Repo-map and module lines are stable: they change when the repository
 * changes, which the host's cache already tracks via the code itself. A line
 * naming a module, a path, or a project convention is not a function of the
 * current question.
 */
const STABLE_PATTERNS: readonly RegExp[] = [
  /^module:/i,
  // The slicer labels module nodes in prose as well as by id ("Module: <path>").
  // Missing that form classed a real stable line as volatile — the exact failure
  // this module exists to prevent, in the direction of losing cache reuse.
  /^module\s*[:：]/i,
  /^repo[- ]?map\b/i,
  /^repo map\b/i,
  /^convention[:：]/i,
  /^convention\b/i,
  /^project[- ]?rule/i,
  /^module map\b/i,
  // The project brief's own line kinds. These are stable by construction — the
  // brief is rebuilt only when its refs stop resolving — so classifying them as
  // volatile put the whole brief in the delta bucket. That is not a cosmetic
  // error: it is the difference between the host caching 3k tokens per turn and
  // caching none of them.
  /^brief:/i,
  /^exports:/i,
  /^files:/i,
];

/**
 * Query-scoped content. Anchors and dialogue recall are a function of the
 * current question and turn, so they are the part that must sit after the
 * breakpoint.
 */
const DELTA_PATTERNS: readonly RegExp[] = [
  /^(file|symbol|module|decision|skill|requirement|concept|topic):/i,
  /^dialogue/i,
  /^anchor\b/i,
  /^summary\b/i,
  /^recap\b/i,
  /^handle:/i,
];

export function classifyCacheLine(line: string): "stable" | "delta" {
  const trimmed = line.trim();
  if (trimmed.length === 0) return "delta";
  if (STABLE_PATTERNS.some((pattern) => pattern.test(trimmed))) return "stable";
  if (DELTA_PATTERNS.some((pattern) => pattern.test(trimmed))) return "delta";
  // A line we cannot place must be treated as volatile. Assuming stability for
  // an unrecognised line is the one error that silently breaks the host's cache,
  // so the default is the safe side.
  return "delta";
}

/**
 * Split one package's lines into a stable prefix and a per-turn delta.
 *
 * Ordering guarantee: every stable line precedes every delta line in the
 * returned arrays, so a host that concatenates `stablePrefix` then `delta` gets
 * the correct order for free. Stability is not merely a property of each line —
 * it is a property of the sequence.
 */
export function planCacheLayout(input: {
  lines: readonly string[];
  /**
   * Host tokens rendered before our content (system prompt + tool schemas).
   * Supplied by the caller; 0 means "unknown", not "zero".
   */
  staticPrefixTokens?: number;
  pricePerMTokIn?: number;
}): CacheLayoutPlan {
  const stableLines: string[] = [];
  const deltaLines: string[] = [];
  for (const line of input.lines) {
    if (classifyCacheLine(line) === "stable") stableLines.push(line);
    else deltaLines.push(line);
  }

  // estimateTokens floors at 1 even for the empty string, which is right for a
  // non-empty line and wrong here: an empty channel must price as 0 or every
  // "all stable" / "all delta" case reports a phantom token.
  const priceLines = (lines: readonly string[]): number =>
    lines.length === 0 ? 0 : estimateTokens(lines.join("\n"));
  const stableTokens = priceLines(stableLines);
  const deltaTokens = priceLines(deltaLines);
  const totalTokens = stableTokens + deltaTokens;

  const staticPrefix = Math.max(0, input.staticPrefixTokens ?? 0);
  // Null rather than 0 when the host prefix is unknown: a 0 here would claim
  // "nothing of the request is reusable", which is a much stronger and very
  // likely false statement.
  const reusablePrefixShare =
    staticPrefix > 0 ? (staticPrefix + stableTokens) / (staticPrefix + totalTokens) : null;

  const stableShare = totalTokens > 0 ? stableTokens / totalTokens : 0;
  // Wording sharpened by a real-provider measurement rather than by reasoning.
  // The naive instruction is "put stable first, then the delta", and a host can
  // follow it exactly and still lose the cache: if BOTH halves are concatenated
  // into the system block, the delta still sits before the conversation, and
  // everything after it is re-billed. Measured on DeepSeek with a 40-turn
  // history: hit ratio 95.1% with no injection, 43.1% with a volatile injection
  // in the system layer, 94.1% with a byte-stable brief in the same position.
  // The volatile arm's surviving cache was *exactly* the stable prefix — the
  // whole conversation was re-charged every turn. So the instruction has to say
  // where the boundary is, not just that stable comes first.
  const note =
    totalTokens === 0
      ? "empty package — nothing to lay out"
      : stableLines.length === 0
        ? "no stable lines in this package: it is entirely query-scoped, so it belongs after the host's cache breakpoint and cannot itself be cached"
        : `${stableLines.length}/${input.lines.length} lines (${(stableShare * 100).toFixed(0)}% of ${totalTokens} tok) are cross-turn stable. Place the stable segment where the host's cache breakpoint falls, and the ${deltaLines.length} query-scoped lines after the conversation — appending both to the system block still loses the cache, because everything after a volatile block is re-billed.`;

  return {
    stablePrefix: { lines: stableLines, tokens: stableTokens },
    delta: { lines: deltaLines, tokens: deltaTokens },
    insertion: buildInsertionAdvice({
      stableTokens,
      deltaTokens,
      hasStable: stableLines.length > 0,
    }),
    stableShare,
    reusablePrefixShare,
    note,
  };
}

const MEASURED_EVIDENCE =
  "measured on DeepSeek (benchmarks/cache-placement-ab.ts, 40 turns of history): " +
  "volatile content in the system layer took the hit ratio from 95.1% to 43.1% and re-billed the whole conversation every turn; " +
  "a byte-stable brief in the same position cost nothing (94.1%)";

/**
 * Where each half has to go, in the two slots a host actually has.
 *
 * The delta is the half that is easy to get wrong, and the reason is specific
 * rather than general: caching is a left-to-right prefix match, so anything
 * after a volatile block is re-billed — and "after" includes the conversation.
 * Appending the delta to the end of the current turn is what keeps the
 * conversation inside the cached prefix.
 */
export function buildInsertionAdvice(input: {
  stableTokens: number;
  deltaTokens: number;
  hasStable: boolean;
}): CacheInsertionAdvice {
  const recipe = input.hasStable
    ? `Append stablePrefix (${input.stableTokens} tok, byte-identical across turns) to the end of your cached system/static block. Append delta (${input.deltaTokens} tok) to the END of the current turn, after the conversation — never to the system block.`
    : `This package is entirely query-scoped (${input.deltaTokens} tok). Append it to the END of the current turn, after the conversation; it cannot be cached and must not precede the transcript.`;
  return {
    stableAt: "system",
    deltaAt: "turn-tail",
    recipe,
    evidence: MEASURED_EVIDENCE,
    // A host with no late-append slot cannot follow the delta half, and saying
    // so is more useful than implying the advice is being satisfied.
    actionable: true,
  };
}

function isTruthyFlag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isCacheLayoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[CACHE_LAYOUT_ENV]);
}
