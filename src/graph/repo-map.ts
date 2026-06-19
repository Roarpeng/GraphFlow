import type { GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

/**
 * Repo-Map: module-level overview compression inspired by Aider's repo-map.
 *
 * Instead of sending full symbol definitions, we generate a high-level "map"
 * where each module gets one line: `path/to/module: exports symbol1, symbol2, ...`
 *
 * This is extremely token-efficient (~100-300 tokens for entire repos) and
 * lets LLMs understand the project structure before diving into specific code.
 */

export interface RepoMapEntry {
  moduleId: string;
  path: string;
  exports: string[];
  tokenEstimate: number;
}

/**
 * Builds a repo map from Module nodes. Each entry summarizes one module's exports.
 */
export async function buildRepoMap(client: GraphClient): Promise<RepoMapEntry[]> {
  if (typeof client.readSnapshot !== "function") {
    return [];
  }

  const snapshot = client.readSnapshot();
  const modules = snapshot.nodes.filter((n) => n.type === "Module");
  const entries: RepoMapEntry[] = [];

  for (const mod of modules) {
    const path = extractModulePath(mod);
    const exports = extractExportedSymbols(mod, snapshot.nodes);
    const line = formatRepoMapLine(path, exports);
    entries.push({
      moduleId: mod.id,
      path,
      exports,
      tokenEstimate: Math.ceil(line.length / 4),
    });
  }

  // Sort by path for readability.
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * Formats the repo map into a single string for injection into LLM context.
 */
export function formatRepoMapString(entries: RepoMapEntry[]): string {
  if (entries.length === 0) {
    return "# Repository Map\n(No modules indexed)\n";
  }

  const lines: string[] = ["# Repository Map", ""];
  for (const entry of entries) {
    lines.push(formatRepoMapLine(entry.path, entry.exports));
  }
  return lines.join("\n");
}

function formatRepoMapLine(path: string, exports: string[]): string {
  if (exports.length === 0) {
    return `${path}`;
  }
  return `${path}: exports ${exports.slice(0, 10).join(", ")}${exports.length > 10 ? ", ..." : ""}`;
}

function extractModulePath(moduleNode: GraphNode): string {
  // Module node content often contains the file path or module name.
  const content = moduleNode.content.trim();
  const pathMatch = content.match(/^(?:module|file):\s*(.+)$/i);
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1].trim();
  }
  // Fallback: use id if it looks like a path.
  if (moduleNode.id.includes("/") || moduleNode.id.includes("\\")) {
    return moduleNode.id;
  }
  return content || moduleNode.id;
}

function extractExportedSymbols(moduleNode: GraphNode, _allNodes: GraphNode[]): string[] {
  // Heuristic: look for Symbol nodes that reference this module via "defines" edges.
  // In practice, you'd traverse edges from the module to its defined symbols.
  // For now, we do a simple name-based heuristic from the module's metadata.
  const meta = moduleNode.metadata;
  if (meta && Array.isArray(meta.exports)) {
    return meta.exports.slice(0, 20).map(String);
  }

  // Fallback: scan content for "exports" keyword.
  const content = moduleNode.content;
  const exportMatches = content.match(/exports?[:\s]+([^\n]+)/gi);
  if (exportMatches) {
    return exportMatches
      .map((m) => m.replace(/^exports?[:\s]+/i, "").trim())
      .slice(0, 10);
  }

  return [];
}

