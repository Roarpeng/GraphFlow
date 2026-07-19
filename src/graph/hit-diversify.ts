import type { GraphNode } from "../core/types.js";
import { extractNodeSourcePath, tokenizeForIndex } from "./graph-utils.js";
import { extractFileFromSymbolId } from "./context-slicer-utils.js";

export const DEFAULT_MAX_SYMBOLS_PER_FILE = 2;
export const DEFAULT_MAX_SIBLING_FILES = 8;

const MODULE_FAMILY_TOKENS = new Set([
  "slice",
  "slices",
  "store",
  "persist",
  "persistence",
  "localstorage",
  "zustand",
  "redux",
]);

const SLICES_PATH_PATTERN = /(?:^|\/)slices(?:\/|$)/i;
const STORE_PATH_PATTERN = /(?:^|\/)store(?:\/|$)/i;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parentDir(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}

function looksLikeSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized || normalized.startsWith("__node__:")) {
    return false;
  }
  // Real indexed symbols use file paths with separators or extensions.
  if (normalized.includes("/") || normalized.includes("\\")) {
    return true;
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|dart|md|json)$/i.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Resolve the source file used for diversify bucketing.
 * When the graph node has no reliable file path (synthetic ids like `symbol:mod0`),
 * fall back to a per-node bucket so diversify does not collapse unrelated symbols
 * that happen to share the first content token (e.g. all starting with "function").
 */
function sourceFileForNode(node: GraphNode): string {
  const fromMeta =
    typeof node.metadata?.file === "string" && node.metadata.file.trim()
      ? node.metadata.file.trim()
      : typeof node.metadata?.sourcePath === "string" && node.metadata.sourcePath.trim()
        ? node.metadata.sourcePath.trim()
        : "";
  if (looksLikeSourcePath(fromMeta)) {
    return normalizePath(fromMeta);
  }

  if (node.type === "Symbol") {
    const fromId = extractFileFromSymbolId(node.id);
    if (fromId && looksLikeSourcePath(fromId)) {
      return normalizePath(fromId);
    }
  }

  const extracted = extractNodeSourcePath(node);
  if (looksLikeSourcePath(extracted)) {
    return normalizePath(extracted);
  }

  return `__node__:${node.id}`;
}

/**
 * Cap Symbol hits per source file and round-robin across files so a hub file
 * (e.g. useGameStore.ts) cannot monopolize the L1 package.
 * File / Module / other node types are preserved in encounter order (no cap).
 */
export function diversifyHitsBySourceFile(
  hits: GraphNode[],
  options?: { maxSymbolsPerFile?: number }
): GraphNode[] {
  const maxSymbols = options?.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE;
  if (hits.length === 0 || maxSymbols < 1) {
    return hits;
  }

  const fileOrder: string[] = [];
  const symbolsByFile = new Map<string, GraphNode[]>();
  const nonSymbols: GraphNode[] = [];
  const nonSymbolSeen = new Set<string>();

  for (const hit of hits) {
    if (hit.type !== "Symbol") {
      if (!nonSymbolSeen.has(hit.id)) {
        nonSymbolSeen.add(hit.id);
        nonSymbols.push(hit);
      }
      continue;
    }
    const file = sourceFileForNode(hit) || hit.id;
    if (!symbolsByFile.has(file)) {
      symbolsByFile.set(file, []);
      fileOrder.push(file);
    }
    symbolsByFile.get(file)!.push(hit);
  }

  const cappedByFile = new Map<string, GraphNode[]>();
  for (const file of fileOrder) {
    cappedByFile.set(file, (symbolsByFile.get(file) ?? []).slice(0, maxSymbols));
  }

  const diversified: GraphNode[] = [];
  const emitted = new Set<string>();

  // Emit non-symbols first (File anchors help sibling expansion seeds).
  for (const node of nonSymbols) {
    diversified.push(node);
    emitted.add(node.id);
  }

  let round = 0;
  let addedInRound = true;
  while (addedInRound) {
    addedInRound = false;
    for (const file of fileOrder) {
      const bucket = cappedByFile.get(file) ?? [];
      const node = bucket[round];
      if (!node || emitted.has(node.id)) {
        continue;
      }
      diversified.push(node);
      emitted.add(node.id);
      addedInRound = true;
    }
    round += 1;
  }

  return diversified;
}

/** True when the query (or seed hits) look like a multi-file store/slice module family. */
export function hasModuleFamilyIntent(
  query: string,
  englishQuery?: string,
  hits?: GraphNode[]
): boolean {
  const tokens = new Set([
    ...tokenizeForIndex(query),
    ...tokenizeForIndex(englishQuery ?? ""),
  ]);
  for (const token of tokens) {
    if (MODULE_FAMILY_TOKENS.has(token.toLowerCase())) {
      return true;
    }
  }
  if (hits) {
    for (const hit of hits.slice(0, 12)) {
      const path = sourceFileForNode(hit);
      if (STORE_PATH_PATTERN.test(path) || SLICES_PATH_PATTERN.test(path)) {
        return true;
      }
    }
  }
  return false;
}

function collectSeedParentDirs(hits: GraphNode[], limit = 8): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (dirs.length >= limit) break;
    const file = sourceFileForNode(hit);
    if (!file) continue;
    let dir = parentDir(file);
    if (!dir) continue;
    // If already inside slices/, promote to the parent store directory.
    if (/\/slices$/i.test(dir)) {
      dir = parentDir(dir);
    }
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function isUnderSiblingScope(filePath: string, parentDirPath: string): boolean {
  const file = normalizePath(filePath);
  const parent = normalizePath(parentDirPath);
  if (!file || !parent) return false;
  if (file === parent || file.startsWith(`${parent}/`)) {
    // Same directory file or nested (including slices/).
    const rel = file.slice(parent.length + 1);
    if (!rel) return false;
    // Allow direct children and slices/* children only (one level of slices).
    const parts = rel.split("/");
    if (parts.length === 1) return true;
    if (parts.length === 2 && parts[0]?.toLowerCase() === "slices") return true;
    return false;
  }
  return false;
}

/**
 * After hub hits (e.g. useGameStore), pull sibling File nodes from the same
 * directory and `slices/` subdirectory so module-family queries cover the family.
 */
export function expandSiblingDirectoryHits(
  hits: GraphNode[],
  allNodes: GraphNode[],
  options?: {
    query?: string;
    englishQuery?: string;
    maxSiblingFiles?: number;
  }
): GraphNode[] {
  const maxSiblingFiles = options?.maxSiblingFiles ?? DEFAULT_MAX_SIBLING_FILES;
  if (
    hits.length === 0 ||
    allNodes.length === 0 ||
    !hasModuleFamilyIntent(options?.query ?? "", options?.englishQuery, hits)
  ) {
    return hits;
  }

  const parents = collectSeedParentDirs(hits);
  if (parents.length === 0) {
    return hits;
  }

  const existingIds = new Set(hits.map((h) => h.id));
  const existingFiles = new Set(
    hits.map((h) => sourceFileForNode(h)).filter(Boolean)
  );

  const siblingFiles: GraphNode[] = [];
  for (const node of allNodes) {
    if (node.type !== "File") continue;
    if (existingIds.has(node.id)) continue;
    const path = sourceFileForNode(node);
    if (!path || existingFiles.has(path)) continue;
    if (!parents.some((parent) => isUnderSiblingScope(path, parent))) continue;
    siblingFiles.push(node);
    existingFiles.add(path);
    if (siblingFiles.length >= maxSiblingFiles) break;
  }

  if (siblingFiles.length === 0) {
    return hits;
  }

  // Prefer one exported Symbol per sibling file when available (helps L1 richness).
  const siblingSymbols: GraphNode[] = [];
  const symbolFiles = new Set<string>();
  for (const fileNode of siblingFiles) {
    const filePath = sourceFileForNode(fileNode);
    if (!filePath) continue;
    for (const node of allNodes) {
      if (node.type !== "Symbol") continue;
      if (existingIds.has(node.id)) continue;
      if (sourceFileForNode(node) !== filePath) continue;
      if (symbolFiles.has(filePath)) break;
      siblingSymbols.push(node);
      symbolFiles.add(filePath);
      break;
    }
  }

  return [...hits, ...siblingFiles, ...siblingSymbols];
}

/** Prepare keyword/vector hits for packing: diversify then sibling-expand. */
export function prepareHitsForPackaging(
  hits: GraphNode[],
  options?: {
    query?: string;
    englishQuery?: string;
    allNodes?: GraphNode[];
    maxSymbolsPerFile?: number;
    maxSiblingFiles?: number;
  }
): GraphNode[] {
  const diversified = diversifyHitsBySourceFile(hits, {
    maxSymbolsPerFile: options?.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE,
  });
  if (!options?.allNodes?.length) {
    return diversified;
  }
  return expandSiblingDirectoryHits(diversified, options.allNodes, {
    ...(options.query !== undefined ? { query: options.query } : {}),
    ...(options.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
    ...(options.maxSiblingFiles !== undefined
      ? { maxSiblingFiles: options.maxSiblingFiles }
      : {}),
  });
}
