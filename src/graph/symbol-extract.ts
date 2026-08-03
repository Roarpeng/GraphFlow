/**
 * Extract code symbol candidates from task descriptions.
 *
 * When a user writes "Fix bridgeDagExecution in orchestrator", the keyword
 * retrieval may find "bridge" and "DAG" nodes but miss the exact symbol
 * `bridgeDagExecution`. This module extracts camelCase/PascalCase tokens
 * and file-path-like patterns from natural language, then uses them as
 * supplementary keyword queries to boost symbol-level recall.
 */

import type { GraphNode } from "../core/types.js";
import type { GraphClient } from "./client-factory.js";

/** Common English words that should NOT be treated as symbol candidates. */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "need", "must", "ought",
  "this", "that", "these", "those", "here", "there", "when", "where",
  "what", "which", "who", "whom", "how", "why", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "but", "and",
  "or", "if", "while", "with", "for", "from", "into", "about", "after",
  "before", "between", "through", "during", "above", "below", "up", "down",
  "out", "off", "over", "under", "again", "once", "add", "fix", "use",
  "new", "old", "not", "get", "set", "run", "try", "put", "per", "vs",
]);

/**
 * Extract camelCase and PascalCase symbol candidates from text.
 *
 * Examples:
 *   "Fix bridgeDagExecution" → ["bridgeDagExecution"]
 *   "refactor UserService and OrderService" → ["UserService", "OrderService"]
 *   "implement incremental graph update" → [] (no camelCase tokens)
 */
export function extractSymbolCandidates(text: string): string[] {
  const candidates = new Set<string>();

  // Match camelCase: starts lowercase, has uppercase letter inside
  // e.g., bridgeDagExecution, indexWorkspaceFiles, createGraphClient
  const camelCasePattern = /\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = camelCasePattern.exec(text)) !== null) {
    const candidate = m[1];
    if (candidate && candidate.length >= 4 && !STOP_WORDS.has(candidate.toLowerCase())) {
      candidates.add(candidate);
    }
  }

  // Match PascalCase: starts uppercase, has at least one more letter
  // e.g., UserService, GraphClient, DagEngine
  const pascalCasePattern = /\b([A-Z][a-z0-9]+[A-Za-z0-9]*)\b/g;
  while ((m = pascalCasePattern.exec(text)) !== null) {
    const candidate = m[1];
    if (candidate && candidate.length >= 4 && !STOP_WORDS.has(candidate.toLowerCase())) {
      candidates.add(candidate);
    }
  }

  // Match file-path-like patterns: foo/bar.ts, src/utils/helper
  const filePathPattern = /\b([\w-]+\/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs))\b/g;
  while ((m = filePathPattern.exec(text)) !== null) {
    if (m[1]) candidates.add(m[1]);
  }

  // Match function-call-like patterns: functionName(
  const funcCallPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  while ((m = funcCallPattern.exec(text)) !== null) {
    const candidate = m[1];
    if (candidate && candidate.length >= 4 && !STOP_WORDS.has(candidate.toLowerCase())) {
      candidates.add(candidate);
    }
  }

  return Array.from(candidates);
}

/**
 * Extract module/file name candidates from task descriptions.
 * Many tasks mention specific modules: "fix bug in config loader",
 * "add tests for DAG engine", "improve file-indexer error handling".
 * These map to files like config/loader.ts, dag-engine.ts, file-indexer.ts.
 */
export function extractModuleNameCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const lower = text.toLowerCase();

  // Common module name patterns in task descriptions
  const modulePatterns = [
    /\b(orchestrat\w*)\b/i,
    /\b(context[\s-]?slic\w*)\b/i,
    /\b(file[\s-]?index\w*)\b/i,
    /\b(dag[\s-]?engine\w*)\b/i,
    /\b(skill[\s-]?flywheel\w*)\b/i,
    /\b(episodic[\s-]?memory\w*)\b/i,
    /\b(agent[\s-]?assign\w*)\b/i,
    /\b(config[\s-]?load\w*)\b/i,
    /\b(client[\s-]?factory\w*)\b/i,
    /\b(graph[\s-]?compress\w*)\b/i,
    /\b(repo[\s-]?map\w*)\b/i,
    /\b(planner|planning)\b/i,
    /\b(triage)\b/i,
    /\b(bridge)\b/i,
    /\b(embedding)\b/i,
    /\b(router|routing)\b/i,
    /\b(nightly[\s-]?train\w*)\b/i,
  ];

  for (const pat of modulePatterns) {
    const m = lower.match(pat);
    if (m && m[1]) candidates.add(m[1]);
  }

  // Also extract hyphenated compound words that look like module names
  const hyphenated = /\b([\w]+-([\w]+))\b/g;
  let m: RegExpExecArray | null;
  while ((m = hyphenated.exec(text)) !== null) {
    if (m[1] && m[1].length >= 5 && !STOP_WORDS.has(m[1].toLowerCase())) {
      candidates.add(m[1]);
    }
  }

  return Array.from(candidates);
}

/**
 * Given symbol candidates, query the graph for matching symbol nodes
 * and return them as supplementary hits to boost recall.
 */
export async function fetchSymbolCandidates(
  client: GraphClient,
  candidates: string[],
  maxResults: number = 10
): Promise<GraphNode[]> {
  if (candidates.length === 0) return [];

  const allHits: GraphNode[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (allHits.length >= maxResults) break;
    try {
      const hits = await client.queryByKeyword(candidate);
      for (const hit of hits) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        // Prioritize Symbol nodes for symbol recall
        if (hit.type === "Symbol" || hit.type === "File") {
          allHits.push(hit);
        }
      }
    } catch {
      // Skip failed queries
    }
  }

  return allHits.slice(0, maxResults);
}

/**
 * Collect import-related file nodes from the graph that reference
 * any of the given seed file paths. This enables multi-hop retrieval:
 * if file A is in context and file B imports A, then B is likely relevant.
 */
export async function collectImportRelatedFiles(
  client: GraphClient,
  seedFilePaths: string[],
  maxResults: number = 5
): Promise<GraphNode[]> {
  if (seedFilePaths.length === 0 || typeof client.getNeighbors !== "function") return [];

  const snapshot = client.readSnapshot?.();
  if (!snapshot) return [];

  const related: GraphNode[] = [];
  const seen = new Set<string>();

  // Find symbols that "imports" or "references" the seed files
  for (const edge of snapshot.edges) {
    if (related.length >= maxResults) break;
    if (edge.relation !== "imports" && edge.relation !== "references") continue;

    // Check if edge.from is a symbol in a seed file
    const sourceFile = edge.from.startsWith("symbol:")
      ? edge.from.split(":")[1]?.split("/").slice(0, -1).join("/")
      : edge.from;

    const isFromSeed = seedFilePaths.some(seed =>
      sourceFile?.includes(seed) || edge.from.includes(seed)
    );

    if (!isFromSeed) continue;

    // The target might be a file or symbol we should include
    const targetId = edge.to;
    if (seen.has(targetId)) continue;
    seen.add(targetId);

    const targetNode = snapshot.nodes.find(n => n.id === targetId);
    if (targetNode && (targetNode.type === "File" || targetNode.type === "Symbol")) {
      related.push(targetNode);
    }
  }

  return related.slice(0, maxResults);
}
