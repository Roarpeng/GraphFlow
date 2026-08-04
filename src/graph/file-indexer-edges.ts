/**
 * file-indexer-edges.ts — Edge building
 *
 * Builds reference, call, and inheritance edges from parsed files
 * and deduplicates them.
 */

import type { GraphEdge, GraphNode } from "../core/types.js";
import type { IndexedSymbol, ParsedFile } from "./file-indexer-nodes.js";
import type { CallRelation, InheritRelation } from "./language-indexers/index.js";
import { REFERENCE_SKIPLIST, resolveCallerAtLine } from "./file-indexer-nodes.js";

/**
 * Deduplicate edges by (from, relation, to) key.
 */
export function dedupEdges(edges: GraphEdge[]): GraphEdge[] {
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

/** 从符号节点 ID 取回所属文件（ID 形如 symbol:{relPath}:{hash}）。 */
function symbolFileOf(nodeId: string): string {
  if (!nodeId.startsWith("symbol:")) {
    return "";
  }
  const rest = nodeId.slice("symbol:".length);
  const idx = rest.indexOf(":");
  return idx > 0 ? rest.slice(0, idx) : rest;
}

/**
 * 廉价预过滤：在跑完整标识符正则前，先用一次 indexOf 扫描判定文件内容中
 * 是否存在任何一个词表符号。大仓中绝大多数文件与跨文件符号无交集，跳过这些
 * 文件可避免 O(文件大小) 的 matchAll 扫描。
 *
 * 正确性：\b\w{3,}\b 命中的 token 必然以完整子串形式出现在内容中，因此
 * "内容不含任何词表符号子串" ⇒ "正则不会产生任何词表命中"，不会漏边。
 */
function containsAnySymbolName(content: string, vocabulary: Set<string>): boolean {
  for (const name of vocabulary) {
    if (content.includes(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Build cross-file reference edges from parsed files using the global symbol index.
 * Used by batch (full workspace) indexing.
 *
 * 复杂度（相对旧实现）：
 * - 旧：每个标识符 token 做长度/黑名单/索引三次判断，且对每个候选定义做
 *   一次字符串前缀比较（O(T × D)，T = 全工作区标识符 token 数，
 *   D = 同名字定义数，前缀比较在热循环内）。
 * - 新：一次性构建"标识符词表"（仅保留可解析名字：长度 >= 3 且不在黑名单），
 *   热循环内每个 token 只做一次 O(1) 词表命中；定义按 (名字, 文件) 预分组
 *   （一次性 O(ΣD)），本文件自己的定义按文件整体跳过（O(1)），不再逐定义做
 *   字符串前缀比较。热循环变为 O(T) 词表查询 + O(T × D_cross) 出边
 *   （D_cross = 跨文件定义数），所有字符串操作移出热循环。
 * 产出的边集合与旧实现完全一致（golden 检索测试不受影响）。
 */
export function buildBatchReferenceEdges(
  parsed: ParsedFile[],
  symbolIndex: Map<string, IndexedSymbol[]>
): { edges: GraphEdge[]; referenceCount: number } {
  const edges: GraphEdge[] = [];
  let referenceCount = 0;
  const identifierRe = /\b\w{3,}\b/g;

  // Nothing can be referenced — skip the regex scan over every file entirely.
  if (symbolIndex.size === 0) {
    return { edges, referenceCount };
  }

  // 标识符词表：把 per-token 的长度/黑名单/索引判断折叠为一次 Set 命中。
  const vocabulary = new Set<string>();
  for (const name of symbolIndex.keys()) {
    if (name.length >= 3 && !REFERENCE_SKIPLIST.has(name)) {
      vocabulary.add(name);
    }
  }

  // 按 (name, file) 预分组定义：本文件定义整桶跳过，跨文件定义直接迭代。
  const defsByFile = new Map<string, Map<string, IndexedSymbol[]>>();
  for (const [name, defs] of symbolIndex) {
    const byFile = new Map<string, IndexedSymbol[]>();
    for (const def of defs) {
      const file = symbolFileOf(def.nodeId);
      const list = byFile.get(file) ?? [];
      list.push(def);
      byFile.set(file, list);
    }
    defsByFile.set(name, byFile);
  }

  for (const file of parsed) {
    if (!file.scannable) {
      continue;
    }
    // 廉价预过滤：文件中不存在任何词表符号时，跳过整个正则扫描（短路）。
    if (!containsAnySymbolName(file.content, vocabulary)) {
      continue;
    }
    const seenThisFile = new Set<string>();
    // matchAll iterates without materializing a giant intermediate array of
    // every identifier (large files can yield tens of thousands of matches).
    const seenIdent = new Set<string>();
    for (const match of file.content.matchAll(identifierRe)) {
      const name = match[0];
      if (seenIdent.has(name)) continue;
      seenIdent.add(name);
      if (!vocabulary.has(name)) {
        continue;
      }
      const byFile = defsByFile.get(name)!;
      for (const [defFile, defs] of byFile) {
        // 本文件内引用不连到本文件定义（旧实现：ownNames + 前缀比较，语义一致）
        if (defFile === file.relPath) {
          continue;
        }
        for (const def of defs) {
          const key = `${file.fileNodeId}|${def.nodeId}`;
          if (seenThisFile.has(key)) {
            continue;
          }
          seenThisFile.add(key);
          edges.push({ from: file.fileNodeId, to: def.nodeId, relation: "references" });
          referenceCount += 1;
        }
      }
    }
  }

  return { edges, referenceCount };
}

/**
 * Build call graph edges (caller → callee) from parsed files.
 * Used by batch (full workspace) indexing.
 */
export function buildBatchCallEdges(
  parsed: ParsedFile[],
  symbolIndex: Map<string, IndexedSymbol[]>
): { edges: GraphEdge[]; callEdgeCount: number } {
  const edges: GraphEdge[] = [];
  let callEdgeCount = 0;

  for (const file of parsed) {
    if (file.calls.length === 0) continue;
    const localByName = new Map<string, string>();
    for (const sym of file.declared) {
      localByName.set(sym.name, sym.nodeId);
    }
    const seenCalls = new Set<string>();
    for (const call of file.calls) {
      const calleeDefs = symbolIndex.get(call.callee);
      if (!calleeDefs || calleeDefs.length === 0) continue;
      const calleeDef =
        calleeDefs.find((d) => d.nodeId.startsWith(`symbol:${file.relPath}:`)) ?? calleeDefs[0];
      if (!calleeDef) continue;

      let callerNodeId: string | undefined;
      if (call.caller) {
        callerNodeId = localByName.get(call.caller);
      }
      if (!callerNodeId) {
        callerNodeId = resolveCallerAtLine(file.declared, call.line);
      }
      if (!callerNodeId) {
        continue;
      }

      const edgeKey = `${callerNodeId}|${calleeDef.nodeId}|calls`;
      if (seenCalls.has(edgeKey)) continue;
      seenCalls.add(edgeKey);

      edges.push({ from: callerNodeId, to: calleeDef.nodeId, relation: "calls" });
      callEdgeCount += 1;
    }
  }

  return { edges, callEdgeCount };
}

/**
 * Build inheritance edges (child → parent) from parsed files.
 * Used by batch (full workspace) indexing.
 */
export function buildBatchInheritEdges(
  parsed: ParsedFile[],
  symbolIndex: Map<string, IndexedSymbol[]>
): { edges: GraphEdge[]; inheritEdgeCount: number } {
  const edges: GraphEdge[] = [];
  let inheritEdgeCount = 0;

  for (const file of parsed) {
    if (file.inherits.length === 0) continue;
    const localByName = new Map<string, string>();
    for (const sym of file.declared) {
      localByName.set(sym.name, sym.nodeId);
    }
    const seenInherits = new Set<string>();
    for (const rel of file.inherits) {
      const childNodeId = localByName.get(rel.child);
      if (!childNodeId) continue;
      const parentDefs = symbolIndex.get(rel.parent);
      if (!parentDefs || parentDefs.length === 0) continue;
      const parentDef =
        parentDefs.find((d) => d.nodeId.startsWith(`symbol:${file.relPath}:`)) ?? parentDefs[0];
      if (!parentDef) continue;

      const edgeKey = `${childNodeId}|${parentDef.nodeId}|inherits`;
      if (seenInherits.has(edgeKey)) continue;
      seenInherits.add(edgeKey);

      edges.push({ from: childNodeId, to: parentDef.nodeId, relation: "inherits" });
      inheritEdgeCount += 1;
    }
  }

  return { edges, inheritEdgeCount };
}

/**
 * Build reference edges for a single file using the graph snapshot.
 * Used by incremental (single-file) indexing.
 */
export function buildSingleFileReferenceEdges(
  fileNodeId: string,
  relPath: string,
  content: string,
  declared: IndexedSymbol[],
  snapshotNodes: GraphNode[]
): { edges: GraphEdge[]; referenceCount: number } {
  const edges: GraphEdge[] = [];
  let referenceCount = 0;
  const ownNames = new Set(declared.map((s) => s.name));

  const symbolIndex = new Map<string, { nodeId: string; file: string }[]>();
  for (const node of snapshotNodes) {
    if (node.type !== "Symbol" || !node.metadata?.name) continue;
    if (typeof node.metadata.file === "string" && node.metadata.file === relPath) continue;
    const list = symbolIndex.get(node.metadata.name as string) ?? [];
    list.push({ nodeId: node.id, file: node.metadata.file as string });
    symbolIndex.set(node.metadata.name as string, list);
  }

  // 标识符词表：per-token 的长度/黑名单/索引判断折叠为一次 Set 命中。
  const vocabulary = new Set<string>();
  for (const name of symbolIndex.keys()) {
    if (name.length >= 3 && !REFERENCE_SKIPLIST.has(name)) {
      vocabulary.add(name);
    }
  }

  // 廉价预过滤：文件中不存在任何词表符号时，跳过整个正则扫描（短路）。
  if (vocabulary.size === 0 || !containsAnySymbolName(content, vocabulary)) {
    return { edges, referenceCount };
  }

  const identifierRe = /\b\w{3,}\b/g;
  const matches = content.match(identifierRe);
  if (!matches) return { edges, referenceCount };

  const seenIdent = new Set<string>();

  for (const name of matches) {
    if (seenIdent.has(name)) continue;
    seenIdent.add(name);
    if (!vocabulary.has(name)) continue;
    if (ownNames.has(name)) continue;
    const defs = symbolIndex.get(name);
    if (!defs || defs.length === 0) continue;
    for (const def of defs) {
      edges.push({ from: fileNodeId, to: def.nodeId, relation: "references" });
      referenceCount += 1;
    }
  }

  return { edges, referenceCount };
}

/**
 * Build call and inheritance edges for a single file using local symbols + snapshot.
 * Used by incremental (single-file) indexing.
 */
export function buildSingleFileCallAndInheritEdges(
  relPath: string,
  declared: IndexedSymbol[],
  fileCalls: CallRelation[],
  fileInherits: InheritRelation[],
  snapshotNodes: GraphNode[]
): { edges: GraphEdge[]; callCount: number; inheritCount: number } {
  const edges: GraphEdge[] = [];
  let callCount = 0;
  let inheritCount = 0;

  // Build combined symbol index: local symbols + snapshot symbols
  const combinedSymbolIndex = new Map<string, { nodeId: string; file: string }[]>();
  for (const sym of declared) {
    const list = combinedSymbolIndex.get(sym.name) ?? [];
    list.push({ nodeId: sym.nodeId, file: relPath });
    combinedSymbolIndex.set(sym.name, list);
  }
  for (const node of snapshotNodes) {
    if (node.type !== "Symbol" || !node.metadata?.name) continue;
    const name = node.metadata.name as string;
    const file = typeof node.metadata.file === "string" ? node.metadata.file : "";
    const list = combinedSymbolIndex.get(name) ?? [];
    list.push({ nodeId: node.id, file });
    combinedSymbolIndex.set(name, list);
  }

  const localByName = new Map<string, string>();
  for (const sym of declared) {
    localByName.set(sym.name, sym.nodeId);
  }

  // Call edges
  for (const call of fileCalls) {
    const calleeDefs = combinedSymbolIndex.get(call.callee);
    if (!calleeDefs || calleeDefs.length === 0) continue;
    const calleeDef = calleeDefs.find((d) => d.file === relPath) ?? calleeDefs[0];
    if (!calleeDef) continue;
    let callerNodeId: string | undefined;
    if (call.caller) {
      callerNodeId = localByName.get(call.caller);
    }
    if (!callerNodeId) {
      callerNodeId = resolveCallerAtLine(declared, call.line);
    }
    if (!callerNodeId) continue;
    edges.push({ from: callerNodeId, to: calleeDef.nodeId, relation: "calls" });
    callCount += 1;
  }

  // Inheritance edges
  for (const rel of fileInherits) {
    const childNodeId = localByName.get(rel.child);
    if (!childNodeId) continue;
    const parentDefs = combinedSymbolIndex.get(rel.parent);
    if (!parentDefs || parentDefs.length === 0) continue;
    const parentDef = parentDefs.find((d) => d.file === relPath) ?? parentDefs[0];
    if (!parentDef) continue;
    edges.push({ from: childNodeId, to: parentDef.nodeId, relation: "inherits" });
    inheritCount += 1;
  }

  return { edges, callCount, inheritCount };
}