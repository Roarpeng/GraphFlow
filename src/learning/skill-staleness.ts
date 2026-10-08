import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { extractProjectSymbols } from "./skill-flywheel";
import { parseCompositeState, parseSkillState, serializeAtomic } from "./skill-store";

/**
 * M4 — deterministic skill invalidation (docs/growth-plan.md §2.1 / §5.5).
 *
 * Skills currently age only through time decay (`computeAdaptiveDecayAmount`,
 * driven by `elapsedPeriods`). Growth-plan §0 rejects time decay as the
 * *primary* staleness mechanism: deterministic version/timestamp judgement
 * beats decay and LLM freshness judgement (+10.8pp, arXiv:2606.01435), and
 * code is one of the few domains that carries its own ground truth.
 *
 * The correct shape is therefore a hard constraint, not a down-weight: when a
 * symbol a skill references no longer resolves, the skill leaves the recall
 * path entirely instead of staying selectable at a lower score.
 *
 * Everything in this module is deterministic and offline — the injected
 * `SymbolLookup` is the only source of truth, `checkedAt` is recorded metadata,
 * and elapsed time never decides staleness. Honesty rule (§5 of the plan):
 * "cannot verify" is a first-class outcome (`no-symbols` / `lookup-error`) and
 * is never reported as either stale or valid.
 */

/**
 * Why a skill was judged the way it was. `no-symbols` and `lookup-error` are
 * deliberately distinct from `resolved`: they mean the check could not be
 * performed at all, which is neither evidence of validity nor of staleness.
 */
export type SkillStalenessReason =
  | "resolved"
  | "missing-symbols"
  | "all-symbols-missing"
  | "no-symbols"
  | "lookup-error";

/**
 * Injectable symbol resolver. Callers build it from a deterministic index
 * (the AST graph's Symbol/File nodes, a workspace file manifest, …) so the
 * check is synchronous, side-effect free and reproducible in tests.
 */
export interface SymbolLookup {
  /** True when the symbol still resolves against the current code base. */
  hasSymbol(symbol: string): boolean;
}

/**
 * The part of a skill that carries its symbol references. Structurally
 * satisfied by an atomic `SkillState`; `symbols` / `atoms` may also be supplied
 * by callers that hold the extraction corpus (episode atoms, bound-symbol list)
 * without persisting them on the node.
 */
export interface SkillSymbolSource {
  id: string;
  /** Skill name — for learned atoms the name *is* the extracted symbol. */
  name?: string;
  /**
   * Explicitly bound symbols. When non-empty this list is authoritative:
   * free-text guidance must not widen the dependency set.
   */
  symbols?: string[];
  /** SkillOpt-lite guidance (numbered plan steps, lessons). */
  guidance?: string;
  /** Extraction atoms recorded for this skill, when the caller has them. */
  atoms?: string[];
}

export interface SkillStaleness {
  skillId: string;
  /** True only when at least one checked symbol failed to resolve. */
  stale: boolean;
  /** Every symbol that no longer resolves (subset of `checkedSymbols`). */
  missingSymbols: string[];
  /** Symbols actually verified — empty means the skill binds no symbol at all. */
  checkedSymbols: string[];
  reason: SkillStalenessReason;
  /**
   * Report metadata only. Never a judgement input: no elapsed-time rule exists
   * anywhere in this module.
   */
  checkedAt: number;
}

/** Build a lookup over a fixed symbol index (e.g. every Symbol/File node id). */
export function symbolLookupFromSet(symbols: Iterable<string>): SymbolLookup {
  const index = new Set<string>();
  for (const symbol of symbols) {
    const trimmed = symbol.trim();
    if (trimmed.length > 0) {
      index.add(trimmed);
    }
  }
  return { hasSymbol: (symbol) => index.has(symbol) };
}

/** Identifier characters used to recover the full token around a candidate. */
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;

/**
 * `extractProjectSymbols` is *evidence* extraction: its camelCase pattern (a
 * lowercase run followed directly by an uppercase letter) can start
 * mid-identifier, so "GraphifyClient" yields "raphifyClient". A fragment can
 * never be resolved, so using it as-is would report a healthy skill as stale —
 * a false "missing" is exactly as dishonest as a false "valid". Growing the
 * candidate back to the complete surrounding identifier recovers the real token
 * without reimplementing the shape patterns (the extraction stays reused, only
 * the boundary is fixed).
 */
function expandToIdentifier(corpus: string, candidate: string): string {
  const at = corpus.indexOf(candidate);
  if (at < 0) {
    return candidate;
  }
  let start = at;
  while (start > 0 && IDENTIFIER_CHAR_RE.test(corpus[start - 1] ?? "")) {
    start -= 1;
  }
  let end = at + candidate.length;
  while (end < corpus.length && IDENTIFIER_CHAR_RE.test(corpus[end] ?? "")) {
    end += 1;
  }
  return corpus.slice(start, end);
}

/**
 * A resolvable code symbol always carries at least one letter; this drops the
 * numeric false positives the shape extractor can produce (e.g. "13.62").
 */
function normalizeSymbol(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!/[A-Za-z]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function dedupeSymbols(tokens: Iterable<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token === undefined || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** Resolve the symbol set a skill claims to depend on (see SkillSymbolSource). */
function collectSkillSymbols(skill: SkillSymbolSource): string[] {
  const explicit = dedupeSymbols((skill.symbols ?? []).map((symbol) => normalizeSymbol(symbol)));
  if (explicit.length > 0) {
    return explicit;
  }
  const parts = [skill.guidance ?? "", ...(skill.atoms ?? []), skill.name ?? ""].filter(
    (part) => part.trim().length > 0
  );
  if (parts.length === 0) {
    return [];
  }
  const corpus = parts.join("\n");
  return dedupeSymbols(
    extractProjectSymbols(corpus).map((token) =>
      normalizeSymbol(expandToIdentifier(corpus, token))
    )
  );
}

export interface ResolveSkillSymbolStatusOptions {
  /** Clock value recorded on the result; defaults to Date.now(). */
  checkedAt?: number;
}

/**
 * Verify every symbol a skill references still resolves.
 *
 * - no bound symbols → `stale: false` with `reason: "no-symbols"`: an
 *   unverifiable skill is neither stale nor known-good, and must be reported
 *   with its own reason so the M4 failure criterion (most skills bind no
 *   symbol → fix extraction) stays measurable.
 * - some symbols gone → `stale: true` (`missing-symbols` /
 *   `all-symbols-missing`).
 * - a throwing lookup → `stale: false` with `reason: "lookup-error"`: an
 *   infrastructure failure is not evidence that the symbol disappeared, so it
 *   must never retire a skill.
 */
export function resolveSkillSymbolStatus(
  skill: SkillSymbolSource,
  lookup: SymbolLookup,
  options?: ResolveSkillSymbolStatusOptions
): SkillStaleness {
  const checkedAt = options?.checkedAt ?? Date.now();
  const checkedSymbols = collectSkillSymbols(skill);

  if (checkedSymbols.length === 0) {
    return {
      skillId: skill.id,
      stale: false,
      missingSymbols: [],
      checkedSymbols: [],
      reason: "no-symbols",
      checkedAt,
    };
  }

  const missingSymbols: string[] = [];
  let lookupFailed = false;
  for (const symbol of checkedSymbols) {
    let resolved = false;
    try {
      resolved = lookup.hasSymbol(symbol) === true;
    } catch {
      lookupFailed = true;
      continue;
    }
    if (!resolved) {
      missingSymbols.push(symbol);
    }
  }

  if (lookupFailed) {
    return {
      skillId: skill.id,
      stale: false,
      missingSymbols,
      checkedSymbols,
      reason: "lookup-error",
      checkedAt,
    };
  }

  if (missingSymbols.length === 0) {
    return {
      skillId: skill.id,
      stale: false,
      missingSymbols: [],
      checkedSymbols,
      reason: "resolved",
      checkedAt,
    };
  }

  return {
    skillId: skill.id,
    stale: true,
    missingSymbols,
    checkedSymbols,
    reason:
      missingSymbols.length === checkedSymbols.length ? "all-symbols-missing" : "missing-symbols",
    checkedAt,
  };
}

/**
 * Recall-path gate for the wiring: a skill marked stale/unrecallable must not
 * be handed to the agent at all (hard constraint), not merely ranked lower.
 *
 * `hidden` is the project's existing recallability flag (soft-hide used by
 * pruneFailedSkills and SkillJack quarantine); `metadata.unrecallable` is the
 * deterministic staleness marker written by revalidateSkills and, like
 * `Decision.metadata.staleGoal` in goal-anchor, lives on the node so it also
 * covers composite skills that carry no `hidden` field.
 */
export function isSkillRecallable(node: GraphNode): boolean {
  if (node.type !== "Skill") {
    return false;
  }
  if (node.metadata?.unrecallable === true) {
    return false;
  }
  const atomic = parseSkillState(node.content);
  if (atomic !== undefined) {
    if (atomic.hidden === true) {
      return false;
    }
    // P0-2 taxonomy: `noise` is documented as never persisted / pruned on load.
    return atomic.outcomeKind !== "noise";
  }
  const composite = parseCompositeState(node.content);
  if (composite !== undefined) {
    return composite.outcomeKind !== "noise";
  }
  // A Skill node that parses as neither shape cannot be trusted for recall.
  return false;
}

export interface RevalidateSkillsOptions {
  /** Deterministic symbol resolver — the only judgement input. */
  lookup: SymbolLookup;
  /** Test seam for the `checkedAt` metadata only; never affects staleness. */
  now?: () => number;
}

export interface RevalidateSkillsResult {
  /** Skill nodes evaluated (unparseable Skill nodes are skipped). */
  checked: number;
  /** Skills currently judged stale (deterministic re-derivation, not a counter). */
  stale: number;
  /** Skills newly marked unrecallable by this pass (0 on a repeat pass). */
  retired: number;
  staleSkillIds: string[];
  /** Skills binding no symbol — unverifiable, reported separately (M4 criterion). */
  noSymbolsSkillIds: string[];
  checkedAt: number;
}

async function listSkillNodes(client: GraphClient): Promise<GraphNode[]> {
  if (typeof client.readSnapshot === "function") {
    return client.readSnapshot().nodes.filter((node) => node.type === "Skill");
  }
  const hits = await client.queryByKeyword("skill");
  return hits.filter((node) => node.type === "Skill");
}

/** Optional authoritative symbol list stamped on the node by the caller. */
function readBoundSymbols(metadata: Record<string, unknown> | undefined): string[] | undefined {
  const raw = metadata?.symbols;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const symbols = raw.filter((value): value is string => typeof value === "string");
  return symbols.length > 0 ? symbols : undefined;
}

function toSkillSymbolSource(
  atomic: ReturnType<typeof parseSkillState>,
  composite: ReturnType<typeof parseCompositeState>,
  fallbackId: string,
  metadata: Record<string, unknown> | undefined
): SkillSymbolSource {
  const symbols = readBoundSymbols(metadata);
  if (atomic !== undefined) {
    return {
      id: atomic.id,
      name: atomic.name,
      ...(atomic.guidance !== undefined ? { guidance: atomic.guidance } : {}),
      ...(symbols !== undefined ? { symbols } : {}),
    };
  }
  if (composite !== undefined) {
    return {
      id: composite.id,
      name: composite.name,
      ...(symbols !== undefined ? { symbols } : {}),
    };
  }
  return { id: fallbackId };
}

/**
 * Index rebuild hook: verify every skill's symbols and soft-retire the stale
 * ones so they can no longer be recalled.
 *
 * Idempotent: a skill already carrying `metadata.unrecallable` is reported but
 * never rewritten, so repeat passes neither re-count nor re-write (this is what
 * makes the "retired must be 0 on the second pass" regression test meaningful).
 *
 * Retirement is monotonic — it never clears `hidden`, because `hidden` is shared
 * with SkillJack quarantine (`quarantineSkillsFromEpisode`) and clearing it
 * would resurrect explicitly revoked memory. Node content is otherwise left
 * byte-identical (in particular `updatedAt` / `lastDecayedAt` are untouched, so
 * this pass cannot feed the time-decay curve). Nothing is ever deleted.
 */
export async function revalidateSkills(
  client: GraphClient,
  options: RevalidateSkillsOptions
): Promise<RevalidateSkillsResult> {
  const checkedAt = options.now !== undefined ? options.now() : Date.now();
  const nodes = (await listSkillNodes(client)).slice().sort((a, b) => a.id.localeCompare(b.id));

  const updates: GraphNode[] = [];
  const staleSkillIds: string[] = [];
  const noSymbolsSkillIds: string[] = [];
  let checked = 0;

  for (const node of nodes) {
    const atomic = parseSkillState(node.content);
    const composite = atomic === undefined ? parseCompositeState(node.content) : undefined;
    if (atomic === undefined && composite === undefined) {
      continue;
    }
    checked += 1;

    const status = resolveSkillSymbolStatus(
      toSkillSymbolSource(atomic, composite, node.id, node.metadata),
      options.lookup,
      { checkedAt }
    );

    if (status.checkedSymbols.length === 0) {
      noSymbolsSkillIds.push(status.skillId);
    }
    if (!status.stale) {
      continue;
    }
    staleSkillIds.push(status.skillId);

    if (node.metadata?.unrecallable === true) {
      continue;
    }

    // `hidden` gives the existing atomic recall filter (collectTaskSkillCandidates)
    // the hard constraint for free; metadata carries the deterministic reason and
    // covers composites, which have no `hidden` field of their own.
    const metadata: Record<string, unknown> = {
      ...(node.metadata ?? {}),
      unrecallable: true,
      staleReason: status.reason,
      staleMissingSymbols: status.missingSymbols,
      staleCheckedAt: checkedAt,
    };
    updates.push(
      atomic !== undefined
        ? {
            id: atomic.id,
            type: "Skill",
            content: serializeAtomic({ ...atomic, hidden: true }),
            metadata,
          }
        : { id: node.id, type: "Skill", content: node.content, metadata }
    );
  }

  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return {
    checked,
    stale: staleSkillIds.length,
    retired: updates.length,
    staleSkillIds,
    noSymbolsSkillIds,
    checkedAt,
  };
}
