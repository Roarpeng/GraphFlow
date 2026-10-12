import type { GraphClient } from "./client-factory";
import type { GraphNode } from "../core/types";
import type { DialogueTurnRecord } from "../learning/dialogue-thread";
import { composeContextQuery, extractNodeSourcePath, nodeSearchableText, tokenizeForIndex } from "./graph-utils";
import { expandCjkGlossaryTerms } from "./cjk-glossary";
import { bm25Idf, createBm25Index, rrfFuse, search as searchBm25, tokenizeBm25 } from "./bm25";
import type { Bm25Doc, Bm25Index } from "./bm25";

export interface SymbolMatch {
  symbol: {
    id: string;
    name: string;
    kind: string;
    file: string;
    line: number;
    signature: string;
  };
  definedIn: string;
  callers: Array<{ name: string; file: string; line: number }>;
  referencers: Array<{ name: string; file: string; line: number }>;
}

export interface QuerySymbolResult {
  query: string;
  matches: SymbolMatch[];
  totalCount: number;
}

export interface SearchGraphResult {
  query: string;
  results: Array<{
    id: string;
    type: string;
    content: string;
    sourcePath: string;
    relevance: number;
  }>;
  totalCount: number;
}

/** Conversation Graph W2b: matched dialogue-turn hit with correction-chain annotation. */
export interface DialogueSearchHit {
  id: string;
  seq: number;
  sessionId: string;
  title?: string;
  summary?: string;
  userQuery: string;
  updatedAt: number;
  /** Non-empty when this turn's conclusion supersedes an earlier one: "结论 X 已被修正为 Y". */
  correctionLine?: string;
  /** True when an earlier turn superseded THIS turn (it is historical context, not current truth). */
  superseded: boolean;
}

/**
 * Bounded echo of `DialogueSearchHit` for `graphflow_context` responses:
 * ids and structural marks verbatim, but `userQuery` is clipped to the
 * shared echo budget (`MAX_ECHO_TURN_CHARS`, see `toDialogueThreadEchoView`)
 * with `truncated` set when anything was cut. Full text stays in the graph
 * store — anchor expansion reads the stored node, never this attached view.
 * 回显瘦身视图：id/seq/sessionId 等结构字段原样，userQuery 裁成预览并标记
 * truncated；全文留在图谱，anchorId 展开走 store 直读，不经过该视图。
 *
 * `updatedAt` is deliberately NOT part of this view: a turn's timestamp moves
 * whenever the same question is asked again inside the dedupe window, so
 * echoing it made the response — and every token after it — churn on a field
 * nothing consumes. The value stays on `DialogueSearchHit` and in the graph.
 */
export interface DialogueHitPreview {
  id: string;
  seq: number;
  sessionId: string;
  title?: string;
  summary?: string;
  userQuery: string;
  /** Non-empty when this turn's conclusion supersedes an earlier one: "结论 X 已被修正为 Y". */
  correctionLine?: string;
  /** True when an earlier turn superseded THIS turn (it is historical context, not current truth). */
  superseded: boolean;
  /** Present (true) only when the stored `userQuery` exceeded the echo clip budget. */
  truncated?: boolean;
}

function getSymbolName(node: GraphNode): string {
  if (typeof node.metadata?.name === "string") {
    return node.metadata.name;
  }
  // Fallback: parse from content like "kind name @file:line" or "kind name (exported) @file:line"
  const match = node.content.match(/^\S+\s+(.+?)(?:\s+\(exported\))?\s+@/);
  return match?.[1] ?? node.content;
}

function nodeToCallerInfo(node: GraphNode): { name: string; file: string; line: number } {
  const name =
    typeof node.metadata?.name === "string"
      ? node.metadata.name
      : node.content.split(/\s+/)[0] ?? "";
  return {
    name,
    file: extractNodeSourcePath(node),
    line: typeof node.metadata?.line === "number" ? node.metadata.line : 0,
  };
}

/**
 * Project a graph node onto the BM25 retrieval fields: symbol name (highest
 * boost), source path (medium), content + jsdoc as free text (lowest).
 * File/Module nodes carry no symbol name unless metadata provides one.
 */
function nodeToBm25Doc(node: GraphNode): Bm25Doc {
  const name =
    typeof node.metadata?.name === "string"
      ? node.metadata.name
      : node.type === "Symbol"
        ? getSymbolName(node)
        : undefined;
  const jsdoc = typeof node.metadata?.jsdoc === "string" ? node.metadata.jsdoc : undefined;
  return {
    id: node.id,
    ...(name !== undefined ? { symbol: name } : {}),
    path: extractNodeSourcePath(node),
    summary: jsdoc ? `${node.content} ${jsdoc}` : node.content,
  };
}

/**
 * Query symbols by name with optional exact matching.
 * For each matched Symbol, resolves:
 *   - defining File node (reverse of "defines")
 *   - caller nodes (reverse of "calls")
 *   - referencer nodes (reverse of "references")
 *
 * Ranking (BM25): matches are ordered by field-weighted BM25 relevance of the
 * symbol name / file against the query tokens — an exact symbol-name match is
 * forced to the front, remaining ties break by score then id, so identical
 * inputs always produce identical ordering.
 */
export async function querySymbolGraph(
  client: GraphClient,
  name: string,
  exact = false
): Promise<QuerySymbolResult> {
  const normalizedQuery = name.toLowerCase();

  let symbolCandidates: GraphNode[];

  if (client.readSnapshot) {
    const snapshot = client.readSnapshot();
    symbolCandidates = snapshot.nodes.filter((n) => n.type === "Symbol");
  } else {
    const keywordHits = await client.queryByKeyword(name);
    symbolCandidates = keywordHits.filter((n) => n.type === "Symbol");
  }

  const matches: SymbolMatch[] = [];

  for (const node of symbolCandidates) {
    const symbolName = getSymbolName(node);
    const isMatch = exact
      ? symbolName === name
      : symbolName.toLowerCase().includes(normalizedQuery) ||
        node.content.toLowerCase().includes(normalizedQuery);

    if (!isMatch) continue;

    // defines reverse -> find File nodes that define this symbol
    const definedInNeighbors =
      client.getNeighbors
        ? await client.getNeighbors([node.id], ["defines"], "in")
        : [];
    const definedInFiles = definedInNeighbors
      .filter((n) => n.node.type === "File")
      .map((n) => extractNodeSourcePath(n.node));
    const definedIn = definedInFiles[0] ?? extractNodeSourcePath(node);

    // calls reverse -> find callers
    const callerNeighbors =
      client.getNeighbors
        ? await client.getNeighbors([node.id], ["calls"], "in")
        : [];
    const callers = callerNeighbors.map((n) => nodeToCallerInfo(n.node));

    // references reverse -> find referencers
    const referenceNeighbors =
      client.getNeighbors
        ? await client.getNeighbors([node.id], ["references"], "in")
        : [];
    const referencers = referenceNeighbors.map((n) => nodeToCallerInfo(n.node));

    matches.push({
      symbol: {
        id: node.id,
        name: symbolName,
        kind: String(node.metadata?.kind ?? ""),
        file: String(node.metadata?.file ?? extractNodeSourcePath(node)),
        line: typeof node.metadata?.line === "number" ? node.metadata.line : 0,
        signature: String(node.metadata?.signature ?? node.content),
      },
      definedIn,
      callers,
      referencers,
    });
  }

  // BM25 ranking over the matched symbol corpus: IDF downweights tokens that
  // hit every match (index/utils/…), the symbol-name field boost lifts exact
  // and near-exact name matches above incidental content hits.
  if (matches.length > 1) {
    const rankIndex = createBm25Index(
      matches.map((match) => ({
        id: match.symbol.id,
        symbol: match.symbol.name,
        path: match.symbol.file,
      }))
    );
    const scores = new Map(
      searchBm25(rankIndex, tokenizeBm25(name)).map(({ id, score }) => [id, score] as const)
    );
    const normalizedQueryForRank = name.toLowerCase();
    matches.sort((a, b) => {
      const exactDiff =
        Number(b.symbol.name.toLowerCase() === normalizedQueryForRank) -
        Number(a.symbol.name.toLowerCase() === normalizedQueryForRank);
      if (exactDiff !== 0) return exactDiff;
      const scoreDiff = (scores.get(b.symbol.id) ?? 0) - (scores.get(a.symbol.id) ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return a.symbol.id.localeCompare(b.symbol.id);
    });
  }

  return {
    query: name,
    matches,
    totalCount: matches.length,
  };
}

/** Optional extra channels for `searchGraphNodes`. */
export interface SearchGraphNodesOptions {
  /**
   * Node ids ranked best-first by a semantic (vector) channel. When non-empty
   * they are fused with the lexical BM25 ranking via RRF (see `rrfFuse`).
   * Ids missing from the keyword result are materialized through
   * `client.getNodesByIds` when the backend supports it; otherwise they are
   * skipped, so callers on limited backends lose nothing by passing them.
   */
  vectorNodeIds?: readonly string[];
}

/**
 * Full-text search over the graph using the client's keyword query, ranked by
 * field-weighted BM25 (symbol name > path > content/jsdoc) instead of raw
 * token overlap:
 *   - IDF downweights corpus-generic tokens (`utils`, `index`, `test`), so a
 *     node matching a distinctive query term outranks one matching only
 *     common ones; the cjk-glossary generic-segment blocklist remains as a
 *     safety net inside the tokenizer.
 *   - Term-frequency saturation + per-field length normalization keep a long
 *     jsdoc from out-scoring a short, precise symbol hit.
 *   - CJK queries are expanded with the server glossary before scoring.
 *
 * Node type priority (Symbol > File > Module) is retained as the deterministic
 * tie-break, and `relevance` reports the lexical BM25 score. When
 * `vectorNodeIds` is supplied, final ordering is RRF-fused with the vector
 * ranking (deterministic, first-seen tie-break).
 */
export async function searchGraphNodes(
  client: GraphClient,
  query: string,
  limit = 20,
  options?: SearchGraphNodesOptions
): Promise<SearchGraphResult> {
  const lexicalNodes = await client.queryByKeyword(query);
  const nodesById = new Map(lexicalNodes.map((node) => [node.id, node] as const));

  let vectorRanking: string[] = [];
  const requestedVectorIds = options?.vectorNodeIds;
  if (requestedVectorIds && requestedVectorIds.length > 0) {
    const missing = requestedVectorIds.filter((id) => !nodesById.has(id));
    if (missing.length > 0 && client.getNodesByIds) {
      const fetched = await client.getNodesByIds(missing);
      for (const node of fetched) {
        if (!nodesById.has(node.id)) {
          nodesById.set(node.id, node);
        }
      }
    }
    vectorRanking = requestedVectorIds.filter((id) => nodesById.has(id));
  }

  const nodes = [...nodesById.values()];

  const glossaryTerms = expandCjkGlossaryTerms(query);
  const queryText = glossaryTerms.length > 0 ? `${query} ${glossaryTerms.join(" ")}` : query;
  const queryTokens = tokenizeBm25(queryText);

  const typePriority: Record<string, number> = {
    Symbol: 0,
    File: 1,
    Module: 2,
  };

  const rankIndex = createBm25Index(nodes.map(nodeToBm25Doc));
  const scores = new Map(
    searchBm25(rankIndex, queryTokens).map(({ id, score }) => [id, score] as const)
  );

  const ranked = nodes
    .map((node) => ({
      node,
      priority: typePriority[node.type] ?? 3,
      score: scores.get(node.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.score - a.score || a.priority - b.priority || a.node.id.localeCompare(b.node.id)
    );

  if (vectorRanking.length > 0) {
    // Both lists are node-id rankings; every lexical node appears in list 1,
    // so the fused order is a total order over `ranked` (deterministic).
    const fused = rrfFuse([ranked.map((entry) => entry.node.id), vectorRanking]);
    const fusedRank = new Map(fused.map((id, position) => [id, position] as const));
    ranked.sort(
      (a, b) => (fusedRank.get(a.node.id) ?? 0) - (fusedRank.get(b.node.id) ?? 0)
    );
  }

  const boundedLimit = Math.max(1, limit);
  const limited = ranked.slice(0, boundedLimit);

  return {
    query,
    results: limited.map(({ node, score }) => ({
      id: node.id,
      type: node.type,
      content: node.content,
      sourcePath: extractNodeSourcePath(node),
      relevance: score,
    })),
    totalCount: nodes.length,
  };
}

// ───────────────── Conversation Graph W2b: dialogue turn recall ─────────────────

/** Optional tuning inputs for `computeAnchorRelevance`. */
export interface AnchorRelevanceOptions {
  /**
   * BM25 index over the anchor candidate corpus. When supplied, each query
   * token's weight is `idf(token) * token.length` — corpus-generic tokens
   * (`utils`, `index`, `test`, …) are strongly downweighted by IDF while
   * distinctive ones keep their full weight. Without an index the legacy
   * length-only weights apply and results are bit-identical to the pre-BM25
   * scorer, so existing consumers keep their calibrated thresholds.
   */
  index?: Bm25Index;
}

/**
 * Normalized 0..1 query relevance for one node: the share of query term
 * tokens (original query + agent-translated English, with CJK phrases and
 * overlapping bigrams) that occur in the node's searchable text.
 *
 * Substring containment rather than exact-token equality, so a query bigram
 * matches inside a longer Chinese run in jsdoc/content—mirroring how
 * `tokenizeCJK` builds overlapping bigrams on both sides.
 *
 * This is the per-anchor quality signal behind the CJK low-relevance
 * query-translate trigger (`shouldDelegateQueryTranslation`): a pure-Chinese
 * query whose anchors were only reached via workspace-path expansion shares
 * no wording with them and scores ~0 even when the anchor count is high.
 *
 * Server-side glossary terms count as query vocabulary too: they drove
 * retrieval (`expandSearchQueries`), so a node they match is genuinely
 * responsive to the query — without this, retrieved English-only truth
 * scores 0 against a CJK query and is trimmed as if unresponsive (T3).
 *
 * Weighted share (BM25): a matched multi-char identifier or glossary term is
 * stronger evidence than a matched 2-char bigram coincidence (T3: the true
 * ledger module matches the distinctive translated terms while noise matches
 * a coincidental bigram), and when `options.index` carries the candidate
 * corpus, IDF scaling additionally demotes corpus-generic tokens so the
 * manual blocklist is belt-and-suspenders only. Single-vocabulary
 * queries shift only through the phrase/bigram length mix, which applies
 * equally to every node, so existing English/CJK baselines hold.
 */
export function computeAnchorRelevance(
  node: GraphNode,
  query: string,
  englishQuery?: string,
  options?: AnchorRelevanceOptions
): number {
  const composed = composeContextQuery(query, englishQuery).trim();
  if (!composed) {
    return 0;
  }
  const glossaryTerms = expandCjkGlossaryTerms(composed);
  const tokens = tokenizeForIndex(
    glossaryTerms.length > 0 ? `${composed} ${glossaryTerms.join(" ")}` : composed
  );
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = nodeSearchableText(node).toLowerCase();
  if (!haystack) {
    return 0;
  }
  let matched = 0;
  let total = 0;
  for (const token of tokens) {
    // idf == 1 without a corpus index (legacy weights, byte-for-byte the old
    // scorer); with one, rare tokens keep their length weight while tokens
    // present in most candidates shrink toward irrelevance.
    const weight = token.length * (options?.index ? bm25Idf(options.index, token) : 1);
    total += weight;
    if (haystack.includes(token.toLowerCase())) {
      matched += weight;
    }
  }
  return total > 0 ? matched / total : 0;
}

/** Max dialogue hits returned per search. */
const DIALOGUE_SEARCH_MAX = 5;
/** Token-overlap floor (hit ratio over the query token set) for a turn to match. */
const DIALOGUE_SEARCH_MIN_RATIO = 0.3;

function dialogueSearchTokens(query: string): Set<string> {
  const out = new Set<string>();
  for (const token of query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (token.length >= 2) out.add(token);
  }
  return out;
}

function dialogueMatchScore(turn: DialogueTurnRecord, tokens: Set<string>): number {
  const haystack = `${turn.userQuery} ${turn.title ?? ""} ${turn.summary ?? ""}`.toLowerCase();
  if (tokens.size === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.size;
}

/**
 * Search effective dialogue turns whose query/title/summary overlap the
 * search query. Each hit carries the correction-chain annotation when the
 * turn supersedes an earlier conclusion, and `superseded` marks historical
 * (superseded) turns so callers can separate current truth from old answers.
 * Dialogue hits are ADDITIVE: they never displace code Symbol/File results
 * and are returned in their own list.
 *
 * Cross-project isolation (P0 gate): when `workspaceRoot` is set, only turns
 * from sessions that hash-verify against that root are searched. The
 * recency window is applied AFTER the workspace filter — a chatty foreign
 * project sharing a legacy store must not crowd this workspace's turns out
 * of the 120-turn recall window.
 */
export async function searchDialogueTurns(
  client: GraphClient,
  query: string,
  options?: { limit?: number; includeSuperseded?: boolean; workspaceRoot?: string }
): Promise<DialogueSearchHit[]> {
  try {
    const { listDialogueTurns, formatSupersessionLine } = await import(
      "../learning/dialogue-thread.js"
    );
    let turns: DialogueTurnRecord[] =
      options?.workspaceRoot !== undefined
        ? await listDialogueTurns(client)
        : await listDialogueTurns(client, { limit: 120 });
    if (options?.workspaceRoot !== undefined) {
      const { listOwnedDialogueSessionIds } = await import("../learning/dialogue-thread.js");
      const owned = await listOwnedDialogueSessionIds(client, options.workspaceRoot);
      // Unattributable sessions cannot be verified, so their turns stay out:
      // isolation wins over recall for records whose ownership is unknown.
      turns = turns.filter((turn) => owned.has(turn.sessionId)).slice(0, 120);
    }
    if (turns.length === 0) return [];

    const tokens = dialogueSearchTokens(query);
    if (tokens.size === 0) return [];

    const byId = new Map(turns.map((t) => [t.id, t]));
    const scored = turns
      .map((turn) => ({ turn, score: dialogueMatchScore(turn, tokens) }))
      .filter((s) => s.score >= DIALOGUE_SEARCH_MIN_RATIO)
      .sort((a, b) => b.score - a.score || b.turn.updatedAt - a.turn.updatedAt || a.turn.id.localeCompare(b.turn.id));

    const limitBounded = Math.max(1, options?.limit ?? DIALOGUE_SEARCH_MAX);
    const hits: DialogueSearchHit[] = [];
    for (const { turn } of scored) {
      if (hits.length >= limitBounded) break;
      const superseded = turn.invalidAt !== undefined;
      if (superseded && options?.includeSuperseded !== true) continue;

      let correctionLine: string | undefined;
      const correctionTargets = (turn.supersedesTurnIds ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is DialogueTurnRecord => Boolean(t));
      if (correctionTargets.length > 0) {
        correctionLine = formatSupersessionLine(
          correctionTargets[correctionTargets.length - 1]!,
          turn
        );
      }

      hits.push({
        id: turn.id,
        seq: turn.seq,
        sessionId: turn.sessionId,
        ...(turn.title ? { title: turn.title } : {}),
        ...(turn.summary ? { summary: turn.summary } : {}),
        userQuery: turn.userQuery,
        updatedAt: turn.updatedAt,
        ...(correctionLine ? { correctionLine } : {}),
        superseded,
      });
    }
    return hits;
  } catch {
    return [];
  }
}
