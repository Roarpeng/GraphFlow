/**
 * file-indexer.ts — Main entry point for file indexing
 *
 * Re-exports public API and implements the two main indexing functions:
 * - indexWorkspaceFiles: full workspace batch indexing
 * - indexSingleFile: incremental single-file indexing
 */

import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { hashTextHex as hashText } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import type { GraphEdge, GraphNode } from "../core/types.js";
import type { GraphClient } from "./client-factory.js";
import { getIndexerForFile } from "./language-indexers/index.js";
import type { CallRelation, InheritRelation } from "./language-indexers/index.js";

// ── Re-exports from sub-modules ──────────────────────────────────────
export type { FileIndexerOptions } from "./file-indexer-walker.js";
export { DEFAULT_EXTENSIONS, DEFAULT_MAX_FILE_SIZE } from "./file-indexer-walker.js";
export { clearGraphIndexArtifacts, hasPendingGraphIndexWork, hasIndexCache } from "./file-indexer-cache.js";
export { resolveCallerAtLine } from "./file-indexer-nodes.js";

// ── Internal imports ─────────────────────────────────────────────────
import { DEFAULT_EXTENSIONS, DEFAULT_MAX_FILE_SIZE, normalizePath, extOf, walkScannableFiles } from "./file-indexer-walker.js";
import type { FileIndexerOptions } from "./file-indexer-walker.js";
import { CACHE_DIR, CACHE_FILE, loadCacheState, saveCacheState } from "./file-indexer-cache.js";
import type {
  IndexedSymbol,
  ParsedFile,
} from "./file-indexer-nodes.js";
import {
  moduleKey,
  buildFileNodesAndEdges,
} from "./file-indexer-nodes.js";
import {
  dedupEdges,
  buildBatchReferenceEdges,
  buildBatchCallEdges,
  buildBatchInheritEdges,
  buildSingleFileReferenceEdges,
  buildSingleFileCallAndInheritEdges,
} from "./file-indexer-edges.js";

// ── Batch workspace indexing ─────────────────────────────────────────

export async function indexWorkspaceFiles(
  client: GraphClient,
  rootDir: string,
  options?: FileIndexerOptions
): Promise<{ indexedFiles: number; indexedSymbols: number; indexedReferences: number }> {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const forceReindex = options?.forceReindex ?? false;

  const cachePath = join(rootDir, CACHE_DIR, CACHE_FILE);
  let cacheState = loadCacheState(cachePath, forceReindex);

  const snapshot = client.readSnapshot?.();
  if (snapshot && snapshot.nodes.length === 0 && snapshot.edges.length === 0 && Object.keys(cacheState).length > 0) {
    cacheState = {};
  }

  const scanned = walkScannableFiles(rootDir, includeExtensions, maxFileSizeBytes);
  const currentRelPaths = new Set(scanned.map((file) => file.relPath));

  if (client.deleteNode) {
    for (const relPath of Object.keys(cacheState)) {
      if (!currentRelPaths.has(relPath)) {
        await pruneFileFromGraph(client, relPath);
        delete cacheState[relPath];
      }
    }
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const parsed: ParsedFile[] = [];

  for (const file of scanned) {
    const relPath = file.relPath;
    const mtimeMs = file.mtimeMs;
    const prev = cacheState[relPath];

    let content = "";
    let currentHash = "";
    let isChanged = forceReindex;

    if (!prev || prev.mtimeMs !== mtimeMs) {
      content = readFileSync(file.absPath, "utf8");
      currentHash = createHash("md5").update(content).digest("hex");
      if (!prev || prev.hash !== currentHash) {
        isChanged = true;
      }
    }

    if (!isChanged) {
      continue;
    }

    if (client.deleteNode) {
      await pruneFileFromGraph(client, relPath);
    }

    if (!content) {
      content = readFileSync(file.absPath, "utf8");
      currentHash = createHash("md5").update(content).digest("hex");
    }

    const nodesStartLen = nodes.length;

    const fileNodeId = `file:${relPath}`;
    const moduleNodeId = `module:${moduleKey(relPath)}`;
    const indexer = getIndexerForFile(relPath);
    const language = indexer?.language ?? (extOf(relPath).replace(/^\./, "") || "text");

    let declared: IndexedSymbol[] = [];
    let imports: string[] = [];
    let fileCalls: CallRelation[] = [];
    let fileInherits: InheritRelation[] = [];

    if (indexer) {
      const extracted = await indexer.extract(relPath, content);
      declared = extracted.symbols.map((sym) => ({
        ...sym,
        nodeId: `symbol:${relPath}:${hashText(sym.name)}`,
      }));
      imports = extracted.imports.map((imp) => imp.module);
      fileCalls = extracted.calls ?? [];
      fileInherits = extracted.inherits ?? [];
    }

    const { nodes: fileNodes, edges: fileEdges } = buildFileNodesAndEdges(
      relPath, file.size, language, declared, imports
    );
    nodes.push(...fileNodes);
    edges.push(...fileEdges);

    parsed.push({
      relPath,
      fileNodeId,
      moduleNodeId,
      declared,
      content,
      scannable: Boolean(indexer),
      calls: fileCalls,
      inherits: fileInherits,
    });

    cacheState[relPath] = {
      mtimeMs,
      hash: currentHash,
      numNodes: nodes.length - nodesStartLen,
    };
  }

  const symbolIndex = new Map<string, IndexedSymbol[]>();
  for (const file of parsed) {
    for (const symbol of file.declared) {
      const list = symbolIndex.get(symbol.name) ?? [];
      list.push(symbol);
      symbolIndex.set(symbol.name, list);
    }
  }

  const { edges: refEdges, referenceCount } = buildBatchReferenceEdges(parsed, symbolIndex);
  edges.push(...refEdges);

  const { edges: callEdges, callEdgeCount } = buildBatchCallEdges(parsed, symbolIndex);
  edges.push(...callEdges);

  const { edges: inheritEdges, inheritEdgeCount } = buildBatchInheritEdges(parsed, symbolIndex);
  edges.push(...inheritEdges);

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));

  saveCacheState(cachePath, cacheState);

  return {
    indexedFiles: nodes.filter((node) => node.type === "File").length,
    indexedSymbols: nodes.filter((node) => node.type === "Symbol").length,
    indexedReferences: referenceCount + callEdgeCount + inheritEdgeCount,
  };
}

// ── Single-file incremental indexing ─────────────────────────────────

export async function indexSingleFile(
  client: GraphClient,
  rootDir: string,
  absPath: string,
  options?: { includeExtensions?: string[]; maxFileSizeBytes?: number }
): Promise<{ indexedFiles: number; indexedSymbols: number; indexedReferences: number; skipped: boolean; reason?: string }> {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;

  // Validate extension
  if (!includeExtensions.some((ext) => absPath.toLowerCase().endsWith(ext))) {
    return { indexedFiles: 0, indexedSymbols: 0, indexedReferences: 0, skipped: true, reason: "extension not in includeExtensions" };
  }

  // Validate size
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return { indexedFiles: 0, indexedSymbols: 0, indexedReferences: 0, skipped: true, reason: "file stat failed" };
  }
  if (stat.size > maxFileSizeBytes) {
    return { indexedFiles: 0, indexedSymbols: 0, indexedReferences: 0, skipped: true, reason: "file exceeds maxFileSizeBytes" };
  }

  const relPath = normalizePath(relative(rootDir, absPath));
  const mtimeMs = stat.mtimeMs;
  const content = readFileSync(absPath, "utf8");
  const currentHash = createHash("md5").update(content).digest("hex");

  const cachePath = join(rootDir, CACHE_DIR, CACHE_FILE);
  const cacheState = loadCacheState(cachePath, false);
  const prev = cacheState[relPath];

  // Skip if unchanged
  if (prev && prev.mtimeMs === mtimeMs && prev.hash === currentHash) {
    return { indexedFiles: 0, indexedSymbols: 0, indexedReferences: 0, skipped: true, reason: "unchanged" };
  }

  // Prune existing nodes for this file
  if (client.deleteNode) {
    await pruneFileFromGraph(client, relPath);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const indexer = getIndexerForFile(relPath);
  const language = indexer?.language ?? (relPath.split(".").pop() ?? "text");

  let declared: IndexedSymbol[] = [];
  let imports: string[] = [];
  let fileCalls: CallRelation[] = [];
  let fileInherits: InheritRelation[] = [];

  if (indexer) {
    const extracted = await indexer.extract(relPath, content);
    declared = extracted.symbols.map((sym) => ({
      ...sym,
      nodeId: `symbol:${relPath}:${hashText(sym.name)}`,
    }));
    imports = extracted.imports.map((imp) => imp.module);
    fileCalls = extracted.calls ?? [];
    fileInherits = extracted.inherits ?? [];
  }

  const { nodes: fileNodes, edges: fileEdges } = buildFileNodesAndEdges(
    relPath, stat.size, language, declared, imports
  );
  nodes.push(...fileNodes);
  edges.push(...fileEdges);

  const fileNodeId = `file:${relPath}`;

  // Cross-file references: scan content against existing graph symbols
  let referenceCount = 0;
  const snapshot = client.readSnapshot?.();
  if (snapshot && indexer) {
    const { edges: refEdges, referenceCount: refCount } = buildSingleFileReferenceEdges(
      fileNodeId, relPath, content, declared, snapshot.nodes
    );
    edges.push(...refEdges);
    referenceCount = refCount;
  }

  // Call graph + inheritance edges
  if (snapshot) {
    const { edges: ciEdges, callCount, inheritCount } = buildSingleFileCallAndInheritEdges(
      relPath, declared, fileCalls, fileInherits, snapshot.nodes
    );
    edges.push(...ciEdges);
    referenceCount += callCount + inheritCount;
  }

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));

  // Update cache entry for this file
  cacheState[relPath] = {
    mtimeMs,
    hash: currentHash,
    numNodes: nodes.length,
  };
  saveCacheState(cachePath, cacheState);

  logger.info({ relPath, symbols: declared.length, references: referenceCount }, "Single file indexed");

  return {
    indexedFiles: 1,
    indexedSymbols: declared.length,
    indexedReferences: referenceCount,
    skipped: false,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

async function pruneFileFromGraph(client: GraphClient, relPath: string): Promise<void> {
  if (!client.readSnapshot || !client.deleteNode) {
    return;
  }

  const snapshot = client.readSnapshot();
  const fileNodeId = `file:${relPath}`;
  const moduleNodeId = `module:${moduleKey(relPath)}`;
  const symbolPrefix = `symbol:${relPath}:`;

  const toDelete = snapshot.nodes.filter(
    (node) =>
      node.id === fileNodeId || node.id === moduleNodeId || node.id.startsWith(symbolPrefix)
  );

  for (const node of toDelete) {
    await client.deleteNode(node.id);
  }
}

