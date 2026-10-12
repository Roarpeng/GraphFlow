/**
 * bm25.ts — pure, deterministic BM25 ranking + Reciprocal Rank Fusion.
 *
 * Replaces the raw token-overlap lexical scoring in graph-search.ts:
 * - IDF downweights corpus-common tokens (`utils`, `index`, `test`, …) so the
 *   manual generic-segment blocklist (cjk-glossary) is belt-and-suspenders
 *   only, not the load-bearing filter.
 * - BM25 term-frequency saturation + per-field length normalization stop a
 *   long jsdoc that repeats a word ten times from beating a short symbol
 *   that matches several distinct query terms.
 * - Field boosts mirror retrieval reality: the symbol NAME is the strongest
 *   signal (exact-name queries must rank first), the source path is medium
 *   evidence, free text (content/jsdoc) is the weakest.
 *
 * Determinism: no clocks, no randomness, Map insertion order everywhere,
 * score ties broken by document insertion order (first indexed wins).
 */

import { filterGenericPathTokens } from "./cjk-glossary";

/** Retrieval fields, strongest evidence first. */
export type Bm25Field = "symbol" | "path" | "summary";

export const BM25_FIELDS: readonly Bm25Field[] = ["symbol", "path", "summary"];

/** One searchable document. All fields optional except the id. */
export interface Bm25Doc {
  id: string;
  /** Symbol / node name — highest boost. */
  symbol?: string;
  /** Source path — medium boost. */
  path?: string;
  /** Free text (content, jsdoc) — lowest boost. */
  summary?: string;
}

export interface Bm25FieldBoosts {
  symbol?: number;
  path?: number;
  summary?: number;
}

export interface Bm25Options {
  /** Term-frequency saturation (default 1.2, canonical BM25). */
  k1?: number;
  /** Length-normalization strength (default 0.75, canonical BM25). */
  b?: number;
  /** Per-field weights; defaults: symbol 3, path 2, summary 1. */
  fieldBoosts?: Bm25FieldBoosts;
}

export interface Bm25Score {
  id: string;
  score: number;
}

type FieldTfs = Record<Bm25Field, Map<string, number>>;
type FieldLengths = Record<Bm25Field, number>;

export interface Bm25Index {
  /** Docs in insertion order — the deterministic tie-break for equal scores. */
  readonly docOrder: readonly string[];
  /** Per-doc, per-field term frequencies (tokens already normalized). */
  readonly docFieldTfs: ReadonlyMap<string, FieldTfs>;
  /** Per-doc token count per field — the BM25 length-normalization input. */
  readonly docFieldLengths: ReadonlyMap<string, FieldLengths>;
  /** Union presence set per doc (any field) — cheap containment checks. */
  readonly docTerms: ReadonlyMap<string, ReadonlySet<string>>;
  /** Document frequency per token across the whole corpus. */
  readonly docFreq: ReadonlyMap<string, number>;
  readonly k1: number;
  readonly b: number;
  readonly fieldBoosts: Readonly<Record<Bm25Field, number>>;
  readonly avgFieldLength: Readonly<Record<Bm25Field, number>>;
}

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const DEFAULT_FIELD_BOOSTS: Record<Bm25Field, number> = {
  symbol: 3,
  path: 2,
  summary: 1,
};

const SEGMENT_RE = /[a-zA-Z0-9_]+|[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function identifierTokens(segment: string): string[] {
  // camelCase / PascalCase boundaries; snake_case and kebab-case are already
  // split by SEGMENT_RE. Emits both the full lowercase identifier and its
  // parts (mirroring splitIdentifierTokens in graph-utils) so a query for
  // "providerPriority" matches the composed form as well as the parts.
  const out: string[] = [];
  const lower = segment.toLowerCase();
  if (lower.length >= 2) out.push(lower);
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const seen = new Set<string>(out);
  for (const piece of spaced.split(/[^a-zA-Z0-9]+/)) {
    if (!piece) continue;
    const token = piece.toLowerCase();
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function cjkTokens(segment: string): string[] {
  // Phrase + overlapping bigrams, mirroring tokenizeCJK in graph-utils: the
  // query side expands CJK the same way, so both vocabularies line up.
  const out: string[] = [segment];
  for (let i = 0; i < segment.length - 1; i += 1) {
    out.push(segment.slice(i, i + 2));
  }
  return out;
}

/**
 * Tokenizer for the BM25 channel: split identifiers on camelCase /
 * snake_case / kebab-case boundaries, lowercase everything, keep CJK phrases
 * and overlapping bigrams. Generic dev-path segments (`src`, `users`, `tmp`,
 * …) are dropped as a safety net on top of IDF downweighting; CJK tokens
 * pass through untouched. Duplicates are PRESERVED across segments (BM25
 * term frequency needs occurrence counts); duplicates within one identifier
 * are not.
 */
export function tokenizeBm25(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const segment of text.match(SEGMENT_RE) ?? []) {
    if (CJK_RE.test(segment)) {
      out.push(...cjkTokens(segment));
    } else {
      out.push(...identifierTokens(segment));
    }
  }
  return filterGenericPathTokens(out);
}

/** Build the index over `docs`. Duplicate ids keep their first occurrence. */
export function createBm25Index(docs: readonly Bm25Doc[], options?: Bm25Options): Bm25Index {
  const k1 = options?.k1 ?? DEFAULT_K1;
  const b = options?.b ?? DEFAULT_B;
  const fieldBoosts: Record<Bm25Field, number> = {
    ...DEFAULT_FIELD_BOOSTS,
    ...(options?.fieldBoosts ?? {}),
  };

  const docOrder: string[] = [];
  const docFieldTfs = new Map<string, FieldTfs>();
  const docFieldLengths = new Map<string, FieldLengths>();
  const docTerms = new Map<string, Set<string>>();
  const docFreq = new Map<string, number>();
  const corpusFieldLengths: Record<Bm25Field, number[]> = { symbol: [], path: [], summary: [] };
  const seenIds = new Set<string>();

  for (const doc of docs) {
    if (!doc || seenIds.has(doc.id)) continue;
    seenIds.add(doc.id);
    docOrder.push(doc.id);

    const tfs: FieldTfs = { symbol: new Map(), path: new Map(), summary: new Map() };
    const lengths: FieldLengths = { symbol: 0, path: 0, summary: 0 };
    const terms = new Set<string>();
    for (const field of BM25_FIELDS) {
      const text = doc[field];
      if (!text) continue;
      const tokens = tokenizeBm25(text);
      lengths[field] = tokens.length;
      corpusFieldLengths[field].push(tokens.length);
      const fieldTf = tfs[field];
      for (const token of tokens) {
        fieldTf.set(token, (fieldTf.get(token) ?? 0) + 1);
        terms.add(token);
      }
    }
    docFieldTfs.set(doc.id, tfs);
    docFieldLengths.set(doc.id, lengths);
    docTerms.set(doc.id, terms);
    for (const token of terms) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const avg = (lengths: number[]): number =>
    lengths.length > 0 ? lengths.reduce((sum, n) => sum + n, 0) / lengths.length : 0;

  return {
    docOrder,
    docFieldTfs,
    docFieldLengths,
    docTerms,
    docFreq,
    k1,
    b,
    fieldBoosts,
    avgFieldLength: {
      symbol: avg(corpusFieldLengths.symbol),
      path: avg(corpusFieldLengths.path),
      summary: avg(corpusFieldLengths.summary),
    },
  };
}

/**
 * BM25 IDF for one token against the indexed corpus. Absent tokens get the
 * maximum IDF — they are rare by definition — which is what downweights
 * corpus-common tokens like `utils` / `index` / `test` below distinctive ones.
 */
export function bm25Idf(index: Bm25Index, token: string): number {
  const df = index.docFreq.get(token) ?? 0;
  const n = index.docOrder.length;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/**
 * Score every document against `queryTokens` with field-weighted BM25
 * (BM25F-style: per-field saturation, boosts summed per term). Only docs
 * matching at least one query token are returned, sorted by score desc with
 * insertion-order tie-break. Duplicate query tokens count once.
 */
export function search(index: Bm25Index, queryTokens: readonly string[]): Bm25Score[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of queryTokens) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  if (unique.length === 0 || index.docOrder.length === 0) return [];

  const rank = new Map(index.docOrder.map((id, i) => [id, i] as const));
  const out: Bm25Score[] = [];

  for (const id of index.docOrder) {
    const tfs = index.docFieldTfs.get(id);
    const lengths = index.docFieldLengths.get(id);
    if (!tfs || !lengths) continue;
    let score = 0;
    for (const token of unique) {
      let termScore = 0;
      for (const field of BM25_FIELDS) {
        const tf = tfs[field].get(token) ?? 0;
        if (tf === 0) continue;
        const avgLen = index.avgFieldLength[field];
        // avgLen > 0 whenever tf > 0 (the field has tokens); the guard keeps
        // the math total anyway.
        const norm = avgLen > 0 ? 1 - index.b + index.b * (lengths[field] / avgLen) : 1;
        const saturation = (tf * (index.k1 + 1)) / (tf + index.k1 * norm);
        termScore += index.fieldBoosts[field] * saturation;
      }
      if (termScore > 0) {
        score += bm25Idf(index, token) * termScore;
      }
    }
    if (score > 0) {
      out.push({ id, score });
    }
  }

  out.sort((a, b) => b.score - a.score || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return out;
}

/**
 * Reciprocal Rank Fusion over id rankings: score(id) = Σ 1 / (k + rank + 1).
 * Deterministic tie-break by first-seen order (list order, then position),
 * matching the GraphNode-typed `reciprocalRankFusion` in learning/embeddings
 * — that one is bound to GraphNode and lives in a module this channel must
 * not grow dependencies into, so the string-id twin lives here.
 */
export function rrfFuse(rankedLists: readonly (readonly string[])[], k = 60): string[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const id = list[rank];
      if (!id) continue;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
      if (!firstSeen.has(id)) {
        firstSeen.set(id, order);
        order += 1;
      }
    }
  }
  return [...scores.keys()].sort((a, b) => {
    const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    return diff !== 0 ? diff : (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0);
  });
}
