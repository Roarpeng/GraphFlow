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
import { logger } from "../utils/logger.js";
import type { AgentWorkItem } from "../core/agent-delegation.js";
import type { GraphEdge, GraphNode } from "../core/types.js";
import type { GraphClient } from "./client-factory.js";
import { getIndexerForFile } from "./language-indexers/index.js";
import { buildDocumentEdges } from "./language-indexers/markdown.js";
import { markdownIndexer } from "./language-indexers/markdown.js";
import type { CallRelation, InheritRelation } from "./language-indexers/index.js";
import { embedAndAttachNodes } from "../learning/embeddings.js";
import {
  convertDocumentToMarkdown,
  DEFAULT_DOCUMENT_MAX_FILE_SIZE,
  isOfficeDocumentPath,
} from "./document-convert.js";
import {
  buildDocumentSemanticWorkItems,
  outlineFromMarkdown,
  type DocumentSemanticTarget,
} from "./document-semantic-bridge.js";

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
  assignSymbolNodeIds,
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
import { buildPlcEdges } from "./language-indexers/plcopen-xml.js";

// ── Batch workspace indexing ─────────────────────────────────────────

/** 单个文件并行索引的处理结果 */
interface FileProcessResult {
  relPath: string;
  fileNodes: GraphNode[];
  fileEdges: GraphEdge[];
  parsedEntry: ParsedFile;
  cacheEntry: { mtimeMs: number; hash: string; numNodes: number };
  /** Present when an office/PDF file was converted and structurally indexed. */
  documentSemantic?: DocumentSemanticTarget;
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
  const officeDoc = isOfficeDocumentPath(relPath);

  let content = "";
  let currentHash = "";
  let isChanged = forceReindex;
  let bytes: Buffer | undefined;

  if (!prev || prev.mtimeMs !== mtimeMs) {
    if (officeDoc) {
      bytes = readFileSync(file.absPath);
      currentHash = createHash("md5").update(bytes).digest("hex");
    } else {
      content = readFileSync(file.absPath, "utf8");
      currentHash = createHash("md5").update(content).digest("hex");
    }
    if (!prev || prev.hash !== currentHash) {
      isChanged = true;
    }
  }

  if (!isChanged) {
    return null;
  }

  let documentSemantic: DocumentSemanticTarget | undefined;

  if (officeDoc) {
    if (!bytes) {
      bytes = readFileSync(file.absPath);
      currentHash = createHash("md5").update(bytes).digest("hex");
    }
    const converted = await convertDocumentToMarkdown(file.absPath, bytes);
    if (!converted.markdown) {
      logger.info(
        { relPath, reason: converted.skippedReason ?? "convert-failed" },
        "skipping office/PDF document (no markdown)"
      );
      // Cache hash so we do not retry every index until the file changes.
      cacheState[relPath] = { mtimeMs, hash: currentHash, numNodes: 0 };
      return null;
    }
    content = converted.markdown;
    documentSemantic = {
      relPath,
      outline: outlineFromMarkdown(content),
      excerpt: content.slice(0, 6000),
    };
  } else if (!content) {
    content = readFileSync(file.absPath, "utf8");
    currentHash = createHash("md5").update(content).digest("hex");
  }

  // 清理该文件在图存储中的旧节点（不同 relPath 的节点互不重叠，并行安全）
  if (client.deleteNode ?? client.deleteNodes) {
    await pruneFileFromGraph(client, [relPath]);
  }

  const fileNodeId = `file:${relPath}`;
  const moduleNodeId = `module:${moduleKey(relPath)}`;
  const indexer = officeDoc ? markdownIndexer : getIndexerForFile(relPath);
  const language = officeDoc
    ? "document"
    : (indexer?.language ?? (extOf(relPath).replace(/^\./, "") || "text"));

  let declared: IndexedSymbol[] = [];
  let imports: string[] = [];
  let fileCalls: CallRelation[] = [];
  let fileInherits: InheritRelation[] = [];

  if (indexer) {
    const extracted = await indexer.extract(relPath, content);
    // 同文件同名符号在此统一消歧：首个保留旧 ID，冲突项追加确定性哈希段
    declared = assignSymbolNodeIds(relPath, extracted.symbols);
    imports = extracted.imports.map((imp) => imp.module);
    fileCalls = extracted.calls ?? [];
    fileInherits = extracted.inherits ?? [];
  }

  const { nodes: fileNodes, edges: fileEdges } = buildFileNodesAndEdges(
    relPath, file.size, language, declared, imports
  );

  if (officeDoc) {
    const fileNode = fileNodes.find((n) => n.id === fileNodeId);
    if (fileNode?.metadata) {
      fileNode.metadata.sourceFormat = extOf(relPath).replace(/^\./, "") || "document";
      fileNode.metadata.convertedVia = "anydoc";
      fileNode.metadata.indexedAs = "markdown";
    }
  }

  if ((language === "markdown" || language === "document") && declared.length > 0) {
    const docEdges = buildDocumentEdges(fileNodeId, declared);
    fileEdges.push(...docEdges);
  }

  if (language === "plcopen" && declared.length > 0) {
    const plcEdges = buildPlcEdges(fileNodeId, declared, imports);
    fileEdges.push(...plcEdges);
  }

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
    ...(documentSemantic ? { documentSemantic } : {}),
  };
}

export async function indexWorkspaceFiles(
  client: GraphClient,
  rootDir: string,
  options?: FileIndexerOptions & { signal?: AbortSignal }
): Promise<{
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
  cancelled?: boolean;
  agentWorkItems?: AgentWorkItem[];
  agentInstructions?: string;
}> {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const forceReindex = options?.forceReindex ?? false;
  const concurrency = Math.max(1, options?.concurrency ?? 10);
  const signal = options?.signal;

  const cachePath = join(rootDir, CACHE_DIR, CACHE_FILE);
  let cacheState = loadCacheState(cachePath, forceReindex);

  const snapshot = client.readSnapshot?.();
  if (snapshot && snapshot.nodes.length === 0 && snapshot.edges.length === 0 && Object.keys(cacheState).length > 0) {
    cacheState = {};
  }

  const scanned = walkScannableFiles(rootDir, includeExtensions, maxFileSizeBytes);
  const currentRelPaths = new Set(scanned.map((file) => file.relPath));

  if (client.deleteNode ?? client.deleteNodes) {
    const stale = Object.keys(cacheState).filter((relPath) => !currentRelPaths.has(relPath));
    if (stale.length > 0) {
      // 批量清理：单次快照读取 + 单次批量删除，避免逐文件全量读写图文件
      await pruneFileFromGraph(client, stale);
      for (const relPath of stale) {
        delete cacheState[relPath];
      }
    }
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const parsed: ParsedFile[] = [];
  const documentTargets: DocumentSemanticTarget[] = [];

  let processedCount = 0;
  for (let i = 0; i < scanned.length; i += concurrency) {
    if (signal?.aborted) {
      logger.info({ processed: processedCount, total: scanned.length }, "工作区索引已取消");
      return {
        indexedFiles: nodes.filter((node) => node.type === "File").length,
        indexedSymbols: nodes.filter((node) => node.type === "Symbol").length,
        indexedReferences: 0,
        cancelled: true,
      };
    }

    const batch = scanned.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((file) => {
        if (signal?.aborted) {
          return Promise.resolve<FileProcessResult | null>(null);
        }
        return processFile(file, cacheState, forceReindex, client);
      })
    );

    for (const result of batchResults) {
      if (result) {
        nodes.push(...result.fileNodes);
        edges.push(...result.fileEdges);
        parsed.push(result.parsedEntry);
        cacheState[result.relPath] = result.cacheEntry;
        if (result.documentSemantic) {
          documentTargets.push(result.documentSemantic);
        }
      }
      processedCount += 1;
      options?.onProgress?.(processedCount, scanned.length);
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
  for (const edge of refEdges) edges.push(edge);

  const { edges: callEdges, callEdgeCount } = buildBatchCallEdges(parsed, symbolIndex);
  for (const edge of callEdges) edges.push(edge);

  const { edges: inheritEdges, inheritEdgeCount } = buildBatchInheritEdges(parsed, symbolIndex);
  for (const edge of inheritEdges) edges.push(edge);

  // Attach embeddings via provider if available.
  if (options?.embeddingProvider) {
    const embedded = await embedAndAttachNodes(nodes, options.embeddingProvider);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i] = embedded[i]!;
    }
  }

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));

  saveCacheState(cachePath, cacheState);

  const agentWorkItems = buildDocumentSemanticWorkItems(documentTargets);
  const result: {
    indexedFiles: number;
    indexedSymbols: number;
    indexedReferences: number;
    agentWorkItems?: AgentWorkItem[];
    agentInstructions?: string;
  } = {
    indexedFiles: nodes.filter((node) => node.type === "File").length,
    indexedSymbols: nodes.filter((node) => node.type === "Symbol").length,
    indexedReferences: referenceCount + callEdgeCount + inheritEdgeCount,
  };
  if (agentWorkItems.length > 0) {
    result.agentWorkItems = agentWorkItems;
    result.agentInstructions = [
      "Document semantic bridge: structural sections/chunks are already indexed.",
      "Optional: answer each document-semantic-* work item with your model,",
      'then graphflow_insight({ mode: "submit", workItemId, response }) to store key entities/claims.',
    ].join(" ");
  }
  return result;
}

// ── Single-file incremental indexing ─────────────────────────────────

export async function indexSingleFile(
  client: GraphClient,
  rootDir: string,
  absPath: string,
  options?: { includeExtensions?: string[]; maxFileSizeBytes?: number; embeddingProvider?: import("../learning/embeddings.js").EmbeddingProvider }
): Promise<{
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
  skipped: boolean;
  reason?: string;
  agentWorkItems?: AgentWorkItem[];
  agentInstructions?: string;
}> {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const officeDoc = isOfficeDocumentPath(absPath);
  const sizeLimit = officeDoc
    ? Math.max(maxFileSizeBytes, DEFAULT_DOCUMENT_MAX_FILE_SIZE)
    : maxFileSizeBytes;

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
  if (stat.size > sizeLimit) {
    return { indexedFiles: 0, indexedSymbols: 0, indexedReferences: 0, skipped: true, reason: "file exceeds maxFileSizeBytes" };
  }

  const relPath = normalizePath(relative(rootDir, absPath));
  const mtimeMs = stat.mtimeMs;
  let content = "";
  let currentHash = "";
  let documentSemantic: DocumentSemanticTarget | undefined;

  if (officeDoc) {
    const bytes = readFileSync(absPath);
    currentHash = createHash("md5").update(bytes).digest("hex");
    const converted = await convertDocumentToMarkdown(absPath, bytes);
    if (!converted.markdown) {
      return {
        indexedFiles: 0,
        indexedSymbols: 0,
        indexedReferences: 0,
        skipped: true,
        reason: converted.skippedReason ?? "document-convert-failed",
      };
    }
    content = converted.markdown;
    documentSemantic = {
      relPath,
      outline: outlineFromMarkdown(content),
      excerpt: content.slice(0, 6000),
    };
  } else {
    content = readFileSync(absPath, "utf8");
    currentHash = createHash("md5").update(content).digest("hex");
  }

  const cachePath = join(rootDir, CACHE_DIR, CACHE_FILE);
  const cacheState = loadCacheState(cachePath, false);
  const prev = cacheState[relPath];

  // Skip if unchanged
  if (prev && prev.mtimeMs === mtimeMs && prev.hash === currentHash) {
    return { indexedFiles: 0, indexedSymbols: 0, indexedReferences: 0, skipped: true, reason: "unchanged" };
  }

  // Prune existing nodes for this file
  if (client.deleteNode ?? client.deleteNodes) {
    await pruneFileFromGraph(client, [relPath]);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const indexer = officeDoc ? markdownIndexer : getIndexerForFile(relPath);
  const language = officeDoc
    ? "document"
    : (indexer?.language ?? (relPath.split(".").pop() ?? "text"));

  let declared: IndexedSymbol[] = [];
  let imports: string[] = [];
  let fileCalls: CallRelation[] = [];
  let fileInherits: InheritRelation[] = [];

  if (indexer) {
    const extracted = await indexer.extract(relPath, content);
    // 同文件同名符号在此统一消歧：首个保留旧 ID，冲突项追加确定性哈希段
    declared = assignSymbolNodeIds(relPath, extracted.symbols);
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

  if (officeDoc) {
    const fileNode = nodes.find((n) => n.id === fileNodeId);
    if (fileNode?.metadata) {
      fileNode.metadata.sourceFormat = extOf(relPath).replace(/^\./, "") || "document";
      fileNode.metadata.convertedVia = "anydoc";
      fileNode.metadata.indexedAs = "markdown";
    }
  }

  if ((language === "markdown" || language === "document") && declared.length > 0) {
    const docEdges = buildDocumentEdges(fileNodeId, declared);
    edges.push(...docEdges);
  }

  if (language === "plcopen" && declared.length > 0) {
    const plcEdges = buildPlcEdges(fileNodeId, declared, imports);
    edges.push(...plcEdges);
  }

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

  // Attach embeddings via provider if available.
  if (options?.embeddingProvider) {
    const embedded = await embedAndAttachNodes(nodes, options.embeddingProvider);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i] = embedded[i]!;
    }
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

  const agentWorkItems = documentSemantic
    ? buildDocumentSemanticWorkItems([documentSemantic])
    : [];
  const out: {
    indexedFiles: number;
    indexedSymbols: number;
    indexedReferences: number;
    skipped: boolean;
    agentWorkItems?: AgentWorkItem[];
    agentInstructions?: string;
  } = {
    indexedFiles: 1,
    indexedSymbols: declared.length,
    indexedReferences: referenceCount,
    skipped: false,
  };
  if (agentWorkItems.length > 0) {
    out.agentWorkItems = agentWorkItems;
    out.agentInstructions =
      "Document semantic bridge: submit document-semantic-* via graphflow_insight to store key entities/claims.";
  }
  return out;
}

// ── Internal helpers ─────────────────────────────────────────────────

async function pruneFileFromGraph(client: GraphClient, relPaths: string[]): Promise<void> {
  if (!client.readSnapshot || (!client.deleteNode && !client.deleteNodes)) {
    return;
  }

  const snapshot = client.readSnapshot();

  // 先收集要删除的节点 ID 集合，便于后续 O(1) 查找悬空边
  const deletedIds = new Set<string>();
  for (const relPath of relPaths) {
    const fileNodeId = `file:${relPath}`;
    const moduleNodeId = `module:${moduleKey(relPath)}`;
    const symbolPrefix = `symbol:${relPath}:`;
    for (const node of snapshot.nodes) {
      if (
        node.id === fileNodeId ||
        node.id === moduleNodeId ||
        node.id.startsWith(symbolPrefix)
      ) {
        deletedIds.add(node.id);
      }
    }
  }

  if (deletedIds.size === 0) {
    return;
  }

  const ids = Array.from(deletedIds);
  if (client.deleteNodes) {
    // 批量删除：后端单次读+写（file）/ 单事务（sqlite / memory），并级联清理悬空边
    await client.deleteNodes(ids);
    return;
  }

  // 旧路径（如 MCP HTTP 试点）：逐节点删除 + 显式清理跨文件悬空边。
  for (const id of ids) {
    await client.deleteNode?.(id);
  }
  if (client.deleteEdge) {
    const currentEdges = client.readSnapshot().edges;
    for (const edge of currentEdges) {
      if (deletedIds.has(edge.from) || deletedIds.has(edge.to)) {
        await client.deleteEdge(edge.from, edge.to, edge.relation);
      }
    }
  }
}
