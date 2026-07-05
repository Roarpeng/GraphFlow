import type { GraphEdge, GraphNode } from "../core/types";

const TOKEN_SPLIT = /[^a-zA-Z0-9_\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

const DEPRIORITIZED_PATH_PATTERNS = [
  /(?:^|\/)\\.cursor\//i,
  /(?:^|\/)Cursor\//,
  /(?:^|\/)docs\/integrations\//i,
  /mcp\.json$/i,
  /package-lock\.json$/i,
];

const PRIORITIZED_PATH_PATTERNS = [
  /(?:^|\/)src\//,
  /(?:^|\/)vscode-extension\/src\//,
  /(?:^|\/)tests\//,
];

const UI_PAGE_PATH_PATTERN = /(?:^|\/)src\/pages\//;
const UI_COMPONENT_PATH_PATTERN = /(?:^|\/)src\/components\//;
const DATA_LAYER_PATH_PATTERN = /(?:^|\/)src\/(?:data|types)\//;

/** Tokens that suggest UI/page behavior rather than shared data types. */
const UI_INTERACTION_TOKENS = new Set([
  "avatar",
  "shield",
  "battle",
  "pose",
  "camera",
  "effect",
  "attack",
  "selection",
  "detection",
  "page",
  "modal",
  "button",
  "animation",
  "render",
]);

export function containsCJK(text: string): boolean {
  return CJK_RE.test(text);
}

/** Extract CJK phrases (2+ chars) and overlapping bigrams for partial matching. */
export function tokenizeCJK(text: string): string[] {
  const phrases = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const phrase of phrases) {
    out.add(phrase);
    for (let i = 0; i < phrase.length - 1; i += 1) {
      out.add(phrase.slice(i, i + 2));
    }
  }
  return [...out];
}

/** Split camelCase, PascalCase, and snake_case identifiers into searchable tokens. */
export function splitIdentifierTokens(part: string): string[] {
  if (!part) return [];
  const out = new Set<string>();
  const lower = part.toLowerCase();
  if (lower.length >= 2) out.add(lower);

  const spaced = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

  for (const piece of spaced.split(/[^a-zA-Z0-9]+/).filter(Boolean)) {
    const token = piece.toLowerCase();
    if (token.length >= 2) out.add(token);
  }

  return [...out];
}

export function tokenizeForIndex(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();

  for (const part of text.split(TOKEN_SPLIT)) {
    if (!part || CJK_RE.test(part)) continue;
    for (const token of splitIdentifierTokens(part)) {
      out.add(token);
    }
  }

  for (const t of tokenizeCJK(text)) {
    out.add(t);
  }

  return [...out];
}

/** Tokens used for re-ranking: original query + agent English + active sub-query. */
export function buildSearchScoreTokens(
  query: string,
  englishQuery?: string,
  subQuery?: string
): string[] {
  const out = new Set<string>();
  for (const text of [query, englishQuery, subQuery]) {
    if (!text?.trim()) continue;
    for (const token of tokenizeForIndex(text)) {
      out.add(token);
    }
  }
  return [...out];
}

/** Derive English-ish tokens from workspace path segments (e.g. fat-battle → battle). */
export function extractPathTokens(workspaceRoot?: string): string[] {
  if (!workspaceRoot?.trim()) return [];
  const out = new Set<string>();
  const normalized = workspaceRoot.replace(/\\/g, "/");

  for (const segment of normalized.split("/")) {
    if (!segment || segment === "." || segment === "..") continue;
    for (const tok of tokenizeForIndex(segment)) {
      out.add(tok);
    }
    const camelParts = segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/);
    for (const part of camelParts) {
      const lower = part.toLowerCase();
      if (lower.length >= 2) out.add(lower);
    }
  }

  return [...out];
}

/**
 * Build search queries for RRF: original query, optional agent-translated English,
 * plus path-derived hints when CJK is present.
 */
export function expandSearchQueries(
  query: string,
  workspaceRoot?: string,
  englishQuery?: string
): string[] {
  const trimmed = query.trim();
  if (!trimmed && !englishQuery?.trim()) return [];

  const out = new Set<string>();
  if (trimmed) out.add(trimmed);

  const en = englishQuery?.trim();
  if (en) {
    out.add(en);
    for (const token of tokenizeForIndex(en)) {
      if (token.length >= 2 && !containsCJK(token)) {
        out.add(token);
      }
    }
  }

  if (containsCJK(trimmed)) {
    const pathTokens = extractPathTokens(workspaceRoot);
    if (pathTokens.length > 0) {
      out.add(pathTokens.join(" "));
      for (const token of pathTokens.slice(0, 8)) {
        out.add(token);
      }
    }
  }

  return [...out];
}

/** All text used for inverted-index lookup (content, jsdoc, paths, symbol names). */
export function nodeSearchableText(node: GraphNode): string {
  const parts: string[] = [node.content];
  const meta = node.metadata;

  if (meta) {
    if (typeof meta.jsdoc === "string") parts.push(meta.jsdoc);
    if (typeof meta.sourcePath === "string") parts.push(meta.sourcePath);
    if (typeof meta.path === "string") parts.push(meta.path);
    if (typeof meta.file === "string") parts.push(meta.file);
    if (typeof meta.name === "string") parts.push(meta.name);
    if (Array.isArray(meta.exports)) {
      parts.push(meta.exports.filter((e): e is string => typeof e === "string").join(" "));
    }
  }

  if (node.id.startsWith("file:")) {
    parts.push(node.id.slice("file:".length));
  } else if (node.id.startsWith("module:")) {
    parts.push(node.id.slice("module:".length));
  } else if (node.id.startsWith("symbol:")) {
    parts.push(node.id.slice("symbol:".length));
  }

  return parts.join(" ");
}

export function dedupEdgesByKey(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const result: GraphEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.relation}|${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}

export function extractNodeSourcePath(node: GraphNode): string {
  const fromMeta = node.metadata?.sourcePath;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim();
  }

  if (node.id.startsWith("file:")) {
    return node.id.slice("file:".length);
  }

  if (node.id.startsWith("symbol:")) {
    const body = node.id.slice("symbol:".length);
    const hashIndex = body.lastIndexOf(":");
    if (hashIndex > 0 && /^[a-z0-9]+$/i.test(body.slice(hashIndex + 1))) {
      return body.slice(0, hashIndex);
    }
  }

  if (node.id.startsWith("module:")) {
    return node.id.slice("module:".length);
  }

  return node.content.split(/\s+/)[0] ?? "";
}

function queryMatchesNode(node: GraphNode, queries: string[]): boolean {
  const searchable = nodeSearchableText(node).toLowerCase();
  for (const query of queries) {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery && searchable.includes(normalizedQuery)) {
      return true;
    }

    for (const phrase of tokenizeCJK(query)) {
      if (phrase.length >= 2 && searchable.includes(phrase)) {
        return true;
      }
    }
  }

  return false;
}

export interface RankNodesOptions {
  scoreTokens?: Iterable<string>;
  matchQueries?: string[];
}

/** Re-rank keyword hits so integration/config noise does not dominate architecture queries. */
export function rankNodesForContextQuery(
  nodes: GraphNode[],
  query: string,
  options?: RankNodesOptions
): GraphNode[] {
  const queryTokens = new Set(options?.scoreTokens ?? tokenizeForIndex(query));
  const matchQueries = options?.matchQueries ?? [query];
  const uiIntent = [...queryTokens].some((token) => UI_INTERACTION_TOKENS.has(token));

  const scored = nodes.map((node) => {
    let score = 0;
    const path = extractNodeSourcePath(node);
    const searchable = nodeSearchableText(node);
    let tokenHits = 0;

    for (const token of tokenizeForIndex(searchable)) {
      if (queryTokens.has(token)) {
        score += 2;
        tokenHits += 1;
      }
    }

    if (tokenHits >= 2) {
      score += tokenHits;
    }

    if (queryMatchesNode(node, matchQueries)) {
      score += 6;
    }

    if (PRIORITIZED_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      score += 8;
    }
    if (uiIntent) {
      if (UI_PAGE_PATH_PATTERN.test(path)) {
        score += 12;
      } else if (UI_COMPONENT_PATH_PATTERN.test(path)) {
        score += 10;
      } else if (DATA_LAYER_PATH_PATTERN.test(path)) {
        score -= 6;
      }
    }
    if (DEPRIORITIZED_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      score -= 12;
    }
    if (node.type === "Symbol") {
      score += 3;
    } else if (node.type === "File") {
      score += 1;
    }

    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return scored.map((entry) => entry.node);
}
