/**
 * file-indexer-nodes.ts — Node building
 *
 * Converts AST-extracted symbols into GraphNode objects,
 * builds File/Module/Symbol nodes, and defines/depends_on/imports edges.
 */

import { posix } from "node:path";
import { hashTextHex as hashText } from "../utils/hash.js";
import type { GraphEdge, GraphNode } from "../core/types.js";
import type {
  CallRelation,
  DeclaredSymbol as ExtractedSymbol,
  InheritRelation,
} from "./language-indexers/index.js";
export interface IndexedSymbol extends ExtractedSymbol {
  nodeId: string;
}

export interface ParsedFile {
  relPath: string;
  fileNodeId: string;
  moduleNodeId: string;
  declared: IndexedSymbol[];
  content: string;
  scannable: boolean;
  calls: CallRelation[];
  inherits: InheritRelation[];
}

export const REFERENCE_SKIPLIST = new Set([
  "if", "for", "let", "const", "var", "this", "new", "return", "true", "false",
  "null", "undefined", "console", "process", "require", "module", "exports",
  "import", "export", "default", "async", "await", "function", "class",
  "interface", "type", "enum", "from", "as", "of", "in", "do", "while",
  "switch", "case", "break", "continue", "throw", "try", "catch", "finally",
  "void", "yield", "number", "string", "boolean", "object", "any", "unknown",
  "never", "Array", "Promise", "Map", "Set", "Date", "Error", "JSON", "Math",
  "Object", "String", "Number", "Boolean", "Symbol", "Function", "RegExp",
  "def", "fn", "pub", "struct", "trait", "impl", "use", "mod", "func",
  "package", "include", "namespace", "typedef", "define", "static", "inline",
  "extern", "virtual", "nil", "None", "True", "False", "int", "char", "long",
  "short", "float", "double", "bool", "auto", "sizeof", "self", "cls",
  "and", "or", "not", "is", "lambda", "global", "nonlocal", "pass", "raise",
  "with", "yield", "make", "len", "cap", "append", "range", "chan", "select",
  "defer", "goto", "fallthrough", "size_t", "uint", "int8", "int16", "int32",
  "int64", "uint8", "uint16", "uint32", "uint64", "byte", "rune", "string",
]);

/**
 * Derive a module key from a relative path by stripping the file extension.
 */
export function moduleKey(relPath: string): string {
  return relPath.replace(/\.(ts|tsx|js|jsx|md|json|py|rs|go|hpp|hxx|cpp|cxx|cc|h|c|java|rb|rake|gemspec)$/i, "");
}

/**
 * Normalize an import target path: strip extensions, resolve relative paths.
 */
export function normalizeImportTarget(target: string, importerRelPath: string): string | undefined {
  let cleaned = target
    .replace(/\\/g, "/")
    .replace(/\.(ts|tsx|js|jsx|py|rs|go|hpp|hxx|cpp|cxx|cc|h|c|java|rb|rake|gemspec)$/i, "");
  if (!cleaned) {
    return undefined;
  }

  if (cleaned.startsWith(".")) {
    const dir = posix.dirname(importerRelPath.replace(/\\/g, "/"));
    cleaned = posix.join(dir, cleaned);
    if (cleaned.startsWith("./")) {
      cleaned = cleaned.slice(2);
    }
  }

  return cleaned;
}

/**
 * Innermost declared symbol at or before `line` (for call attribution when caller name is missing).
 */
export function resolveCallerAtLine(
  declared: Array<Pick<IndexedSymbol, "line" | "nodeId">>,
  line: number
): string | undefined {
  const sorted = [...declared].sort((a, b) => b.line - a.line);
  for (const sym of sorted) {
    if (sym.line <= line) {
      return sym.nodeId;
    }
  }
  return undefined;
}

/**
 * Build GraphNode and GraphEdge arrays for a single file.
 * Returns the nodes, edges, declared symbols, imports, calls, and inherits.
 */
export function buildFileNodesAndEdges(
  relPath: string,
  fileSize: number,
  language: string,
  declared: IndexedSymbol[],
  imports: string[]
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const fileNodeId = `file:${relPath}`;
  const moduleNodeId = `module:${moduleKey(relPath)}`;

  const exportNames = declared
    .filter((s) => s.exported && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s.name))
    .map((s) => s.name);
  const uniqueExports = Array.from(new Set(exportNames));
  const exportsSuffix = uniqueExports.length > 0
    ? ` # exports: ${uniqueExports.slice(0, 8).join(", ")}`
    : "";

  nodes.push({
    id: fileNodeId,
    type: "File",
    content: `${relPath}${exportsSuffix}`,
    metadata: {
      path: relPath,
      language,
      exports: uniqueExports,
      symbolCount: declared.length,
      sizeBytes: fileSize,
    },
  });
  nodes.push({ id: moduleNodeId, type: "Module", content: moduleKey(relPath) });
  edges.push({ from: fileNodeId, to: moduleNodeId, relation: "depends_on" });

  for (const symbol of declared) {
    const compactSig = `${symbol.kind} ${symbol.name}${symbol.exported ? " (exported)" : ""} @${relPath}:${symbol.line}`;
    const signature = symbol.signature ?? compactSig;
    const signatureHash = hashText(`${signature}\n${symbol.jsdoc ?? ""}\n${symbol.returnType ?? ""}`);
    nodes.push({
      id: symbol.nodeId,
      type: "Symbol",
      content: compactSig,
      metadata: {
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported,
        line: symbol.line,
        file: relPath,
        signature,
        signatureHash,
        ...(symbol.jsdoc ? { jsdoc: symbol.jsdoc } : {}),
        ...(symbol.visibility ? { visibility: symbol.visibility } : {}),
        ...(symbol.paramsCount !== undefined ? { paramsCount: symbol.paramsCount } : {}),
        ...(symbol.returnType ? { returnType: symbol.returnType } : {}),
        ...(symbol.complexity !== undefined ? { complexity: symbol.complexity } : {}),
      },
    });
    edges.push({ from: fileNodeId, to: symbol.nodeId, relation: "defines" });
  }

  for (const target of imports) {
    const targetModule = normalizeImportTarget(target, relPath);
    if (!targetModule) {
      continue;
    }
    const importNodeId = `module:${targetModule}`;
    nodes.push({ id: importNodeId, type: "Module", content: targetModule });
    edges.push({ from: moduleNodeId, to: importNodeId, relation: "imports" });
  }

  return { nodes, edges };
}