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

/** 单个文件并行索引的处理结果 */
interface FileProcessResult {
  relPath: string;
  fileNodes: GraphNode[];
  fileEdges: GraphEdge[];
  parsedEntry: ParsedFile;
  cacheEntry: { mtimeMs: number; hash: string; numNodes: number };
}

/**
 * 处理单个文件：读取内容、检查缓存、调用语言索引器提取符号/边。
 * 返回 null 表示该文件未变更、被跳过。
 *
 * 该函数是并行安全：不修改共享的 nodes/edges/parsed 数组，
 * 只返回本文件的局部结果，由调用方顺序合并。
 */
async function processFile(
  file: { absPath: string; relPath: string; size: number; mtimeMs: number },
  cacheState: import("./file-indexer-cache.js").CacheState,
  forceReindex: boolean,
  client: GraphClient,
): Promise<FileProcessResult | null> {
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
    return null;
  }

  // 清理该文件在图存储中的旧节点（不同 relPath 的节点互不重叠，并行安全）
  if (client.deleteNode) {
    await pruneFileFromGraph(client, relPath);
  }

  if (!content) {
    content = readFileSync(file.absPath, "utf8");
    currentHash = createHash("md5").update(content).digest("hex");
  }

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

  return {
    relPath,
    fileNodes,
    fileEdges,
    parsedEntry: {
      relPath,
      fileNodeId,
      moduleNodeId,
      declared,
      content,
      scannable: Boolean(indexer),
      calls: fileCalls,
      inherits: fileInherits,
    },
    cacheEntry: {
      mtimeMs,
      hash: currentHash,
      numNodes: fileNodes.length,
    },
  };
}

export async function indexWorkspaceFiles(
  client: GraphClient,
  rootDir: string,
  options?: FileIndexerOptions
): Promise<{ indexedFiles: number; indexedSymbols: number; indexedReferences: number }> {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const forceReindex = options?.forceReindex ?? false;
  // 并行索引并发数，默认每批 10 个文件
  const concurrency = Math.max(1, options?.concurrency ?? 10);

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

  // ── 并行分批索引：每批 concurrency 个文件并行处理 ──
  let processedCount = 0;
  for (let i = 0; i < scanned.length; i += concurrency) {
    const batch = scanned.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((file) => processFile(file, cacheState, forceReindex, client))
    );

    // 顺序合并本批结果到共享数组（避免并行写冲突）
    for (const result of batchResults) {
      if (result) {
        nodes.push(...result.fileNodes);
        edges.push(...result.fileEdges);
        parsed.push(result.parsedEntry);
        cacheState[result.relPath] = result.cacheEntry;
      }
      processedCount += 1;
      // 每 100 个文件输出一次进度日志
      if (processedCount > 0 && processedCount % 100 === 0) {
        logger.info(
          { processed: processedCount, total: scanned.length, percent: `${((processedCount / scanned.length) * 100).toFixed(1)}%` },
          "工作区索引进度",
        );
      }
    }
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

  // 先收集要删除的节点 ID 集合，便于后续 O(1) 查找悬空边
  const deletedIds = new Set<string>();
  const toDelete = snapshot.nodes.filter(
    (node) =>
      node.id === fileNodeId || node.id === moduleNodeId || node.id.startsWith(symbolPrefix)
  );

  for (const node of toDelete) {
    deletedIds.add(node.id);
    await client.deleteNode(node.id);
  }

  // 清理跨文件的悬空引用边：删除任何 from 或 to 指向已删除节点 ID 的边。
  // 某些传输后端（如 MCP HTTP）的 deleteNode 不保证级联清理边，因此显式清理以确保一致。
  if (client.deleteEdge && deletedIds.size > 0) {
    // 重新读取快照以获取当前边状态（部分后端的 deleteNode 可能已级联删除相关边）
    const currentEdges = client.readSnapshot().edges;
    for (const edge of currentEdges) {
      if (deletedIds.has(edge.from) || deletedIds.has(edge.to)) {
        await client.deleteEdge(edge.from, edge.to, edge.relation);
      }
    }
  }
}

