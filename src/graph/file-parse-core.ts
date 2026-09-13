/**
 * file-parse-core.ts — pure per-file parse/symbol-extraction step.
 *
 * Split out of `file-indexer.ts` so the SAME code runs in-process and inside the
 * index worker pool (`file-parse-worker.ts`). It never touches the graph client:
 * callers own cache decisions, pruning and persistence.
 */

import type { GraphEdge, GraphNode } from "../core/types.js";
import {
  assignSymbolNodeIds,
  buildFileNodesAndEdges,
  moduleKey,
  type IndexedSymbol,
  type ParsedFile,
} from "./file-indexer-nodes.js";
import { getIndexerForFile } from "./language-indexers/index.js";
import { buildDocumentEdges } from "./language-indexers/markdown.js";
import { markdownIndexer } from "./language-indexers/markdown.js";
import type { CallRelation, InheritRelation } from "./language-indexers/index.js";
import { buildPlcEdges } from "./language-indexers/plcopen-xml.js";
import { extOf } from "./file-indexer-walker.js";

export interface ParseFileInput {
  relPath: string;
  content: string;
  /** Byte size of the source file (kept in the File node). */
  size: number;
  /** True when `content` is markdown converted from an office/PDF document. */
  officeDoc?: boolean;
}

export interface ParsedFileResult {
  fileNodes: GraphNode[];
  fileEdges: GraphEdge[];
  parsedEntry: ParsedFile;
}

/** Extract symbols/edges for one file. Pure w.r.t. shared state. */
export async function parseFileForIndex(input: ParseFileInput): Promise<ParsedFileResult> {
  const { relPath, content, size } = input;
  const officeDoc = input.officeDoc === true;
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
    relPath,
    size,
    language,
    declared,
    imports
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
  };
}
