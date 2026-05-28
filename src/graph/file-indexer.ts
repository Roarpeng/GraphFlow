import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { GraphEdge } from "../core/types";
import type { GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

export interface FileIndexerOptions {
  includeExtensions?: string[];
  maxFileSizeBytes?: number;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".md", ".json"];
const DEFAULT_MAX_FILE_SIZE = 200_000;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);

export async function indexWorkspaceFiles(
  client: GraphClient,
  rootDir: string,
  options?: FileIndexerOptions
): Promise<{ indexedFiles: number; indexedSymbols: number }> {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;

  const files = walkFiles(rootDir, includeExtensions);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const file of files) {
    const stat = statSync(file);
    if (stat.size > maxFileSizeBytes) {
      continue;
    }

    const relPath = normalizePath(relative(rootDir, file));
    const content = readFileSync(file, "utf8");
    const fileNodeId = `file:${relPath}`;
    nodes.push({ id: fileNodeId, type: "File", content: relPath });

    const moduleNodeId = `module:${moduleKey(relPath)}`;
    nodes.push({ id: moduleNodeId, type: "Module", content: moduleKey(relPath) });
    edges.push({ from: fileNodeId, to: moduleNodeId, relation: "depends_on" });

    const symbolLines = extractSymbolLines(content);
    for (const symbol of symbolLines) {
      const symbolNodeId = `symbol:${relPath}:${hashText(symbol)}`;
      nodes.push({
        id: symbolNodeId,
        type: "Symbol",
        content: `${relPath}::${symbol}`,
      });
      edges.push({ from: fileNodeId, to: symbolNodeId, relation: "defines" });
    }

    const importTargets = extractImportTargets(content);
    for (const target of importTargets) {
      const targetModule = normalizeImportTarget(target);
      if (!targetModule) {
        continue;
      }

      const importNodeId = `module:${targetModule}`;
      nodes.push({ id: importNodeId, type: "Module", content: targetModule });
      edges.push({ from: moduleNodeId, to: importNodeId, relation: "imports" });
    }
  }

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));

  return {
    indexedFiles: nodes.filter((node) => node.type === "File").length,
    indexedSymbols: nodes.filter((node) => node.type === "Symbol").length,
  };
}

function walkFiles(rootDir: string, includeExtensions: string[]): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      files.push(...walkFiles(full, includeExtensions));
      continue;
    }

    if (includeExtensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }

  return files;
}

function extractSymbolLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("export ") || line.startsWith("function "))
    .slice(0, 80);
}

function extractImportTargets(content: string): string[] {
  const matches = content.matchAll(/(?:import\s+[^"']+from\s+|require\()\s*["']([^"']+)["']/g);
  const targets: string[] = [];
  for (const match of matches) {
    const target = match[1]?.trim();
    if (target) {
      targets.push(target);
    }
  }
  return targets.slice(0, 120);
}

function normalizeImportTarget(target: string): string | undefined {
  const cleaned = target.replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx)$/i, "");
  if (!cleaned) {
    return undefined;
  }
  return cleaned;
}

function moduleKey(relPath: string): string {
  return relPath.replace(/\.(ts|tsx|js|jsx|md|json)$/i, "");
}

function dedupEdges(edges: GraphEdge[]): GraphEdge[] {
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

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function normalizePath(pathText: string): string {
  return pathText.replace(/\\/g, "/");
}
