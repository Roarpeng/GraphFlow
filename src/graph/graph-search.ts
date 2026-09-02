import type { GraphClient } from "./client-factory";
import type { GraphNode } from "../core/types";
import type { DialogueTurnRecord } from "../learning/dialogue-thread";
import { extractNodeSourcePath } from "./graph-utils";

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
 * Query symbols by name with optional exact matching.
 * For each matched Symbol, resolves:
 *   - defining File node (reverse of "defines")
 *   - caller nodes (reverse of "calls")
 *   - referencer nodes (reverse of "references")
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

  return {
    query: name,
    matches,
    totalCount: matches.length,
  };
}

/**
 * Full-text search over the graph using the client's keyword query.
 * Results are ranked by node type priority: Symbol > File > Module.
 */
export async function searchGraphNodes(
  client: GraphClient,
  query: string,
  limit = 20
): Promise<SearchGraphResult> {
  const nodes = await client.queryByKeyword(query);

  const typePriority: Record<string, number> = {
    Symbol: 0,
    File: 1,
    Module: 2,
  };

  const sorted = nodes
    .map((node) => {
      const priority = typePriority[node.type] ?? 3;
      const relevance =
        node.type === "Symbol"
          ? 100
          : node.type === "File"
            ? 50
            : node.type === "Module"
              ? 25
              : 10;
      return { node, priority, relevance };
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return b.relevance - a.relevance || a.node.id.localeCompare(b.node.id);
    });

  const boundedLimit = Math.max(1, limit);
  const limited = sorted.slice(0, boundedLimit);

  return {
    query,
    results: limited.map(({ node, relevance }) => ({
      id: node.id,
      type: node.type,
      content: node.content,
      sourcePath: extractNodeSourcePath(node),
      relevance,
    })),
    totalCount: nodes.length,
  };
}

// ───────────────── Conversation Graph W2b: dialogue turn recall ─────────────────

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
 */
export async function searchDialogueTurns(
  client: GraphClient,
  query: string,
  options?: { limit?: number; includeSuperseded?: boolean }
): Promise<DialogueSearchHit[]> {
  try {
    const { listDialogueTurns, formatSupersessionLine } = await import(
      "../learning/dialogue-thread.js"
    );
    const turns: DialogueTurnRecord[] = await listDialogueTurns(client, { limit: 120 });
    if (turns.length === 0) return [];

    const tokens = dialogueSearchTokens(query);
    if (tokens.size === 0) return [];

    const byId = new Map(turns.map((t) => [t.id, t]));
    const scored = turns
      .map((turn) => ({ turn, score: dialogueMatchScore(turn, tokens) }))
      .filter((s) => s.score >= DIALOGUE_SEARCH_MIN_RATIO)
      .sort((a, b) => b.score - a.score || b.turn.updatedAt - a.turn.updatedAt);

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
