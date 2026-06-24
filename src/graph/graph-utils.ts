import type { GraphEdge, GraphNode } from "../core/types";

const TOKEN_SPLIT = /[^a-z0-9_]+/g;

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

export function tokenizeForIndex(text: string): string[] {
  if (!text) return [];
  const tokens = text.toLowerCase().split(TOKEN_SPLIT);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length >= 2) out.push(t);
  }
  return out;
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

/** Re-rank keyword hits so integration/config noise does not dominate architecture queries. */
export function rankNodesForContextQuery(nodes: GraphNode[], query: string): GraphNode[] {
  const queryTokens = new Set(tokenizeForIndex(query));
  const scored = nodes.map((node) => {
    let score = 0;
    const path = extractNodeSourcePath(node);

    for (const token of tokenizeForIndex(node.content)) {
      if (queryTokens.has(token)) {
        score += 2;
      }
    }

    if (PRIORITIZED_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      score += 8;
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
