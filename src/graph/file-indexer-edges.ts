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

/**
 * Build cross-file reference edges from parsed files using the global symbol index.
 * Used by batch (full workspace) indexing.
 */
export function buildBatchReferenceEdges(
  parsed: ParsedFile[],
  symbolIndex: Map<string, IndexedSymbol[]>
): { edges: GraphEdge[]; referenceCount: number } {
  const edges: GraphEdge[] = [];
  let referenceCount = 0;
  const identifierRe = /\b\w{3,}\b/g;

  for (const file of parsed) {
    if (!file.scannable) {
      continue;
    }
    const ownNames = new Set(file.declared.map((s) => s.name));
    const seenThisFile = new Set<string>();
    const matches = file.content.match(identifierRe);
    if (!matches) continue;
    const seenIdent = new Set<string>();
    for (const name of matches) {
      if (seenIdent.has(name)) continue;
      seenIdent.add(name);
      if (name.length < 3 || REFERENCE_SKIPLIST.has(name)) {
        continue;
      }
      const defs = symbolIndex.get(name);
      if (!defs || defs.length === 0) {
        continue;
      }
      for (const def of defs) {
        if (ownNames.has(name) && def.nodeId.startsWith(`symbol:${file.relPath}:`)) {
          continue;
        }
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
  const identifierRe = /\b\w{3,}\b/g;
  const matches = content.match(identifierRe);
  if (!matches) return { edges, referenceCount };

  const seenIdent = new Set<string>();
  const symbolIndex = new Map<string, { nodeId: string; file: string }[]>();
  for (const node of snapshotNodes) {
    if (node.type !== "Symbol" || !node.metadata?.name) continue;
    if (typeof node.metadata.file === "string" && node.metadata.file === relPath) continue;
    const list = symbolIndex.get(node.metadata.name as string) ?? [];
    list.push({ nodeId: node.id, file: node.metadata.file as string });
    symbolIndex.set(node.metadata.name as string, list);
  }

  for (const name of matches) {
    if (seenIdent.has(name)) continue;
    seenIdent.add(name);
    if (name.length < 3 || REFERENCE_SKIPLIST.has(name)) continue;
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