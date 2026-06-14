import type { GraphEdge } from "../core/types";

const TOKEN_SPLIT = /[^a-z0-9_]+/g;

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
