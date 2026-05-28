import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

  for (const file of files) {
    const stat = statSync(file);
    if (stat.size > maxFileSizeBytes) {
      continue;
    }

    const relPath = normalizePath(relative(rootDir, file));
    const content = readFileSync(file, "utf8");
    nodes.push({ id: `file:${relPath}`, type: "File", content: relPath });

    const symbolLines = extractSymbolLines(content);
    for (const symbol of symbolLines) {
      nodes.push({
        id: `symbol:${relPath}:${hashText(symbol)}`,
        type: "Symbol",
        content: `${relPath}::${symbol}`,
      });
    }
  }

  await client.upsertNodes(nodes);

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
