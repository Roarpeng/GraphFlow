import type { GraphClient } from "./client-factory";
import type { GraphNode } from "../core/types";
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
