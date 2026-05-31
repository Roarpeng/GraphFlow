import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";
import {
  ALL_LANGUAGE_EXTENSIONS,
  getIndexerForFile,
  type DeclaredSymbol as ExtractedSymbol,
} from "./language-indexers/index";

export interface FileIndexerOptions {
  includeExtensions?: string[];
  maxFileSizeBytes?: number;
}

const BASE_EXTENSIONS = [".md", ".json"];
const DEFAULT_EXTENSIONS = Array.from(
  new Set([...ALL_LANGUAGE_EXTENSIONS, ...BASE_EXTENSIONS])
);
const DEFAULT_MAX_FILE_SIZE = 200_000;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);

const REFERENCE_SKIPLIST = new Set([
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

interface IndexedSymbol extends ExtractedSymbol {
  nodeId: string;
}

interface ParsedFile {
  relPath: string;
  fileNodeId: string;
  moduleNodeId: string;
  declared: IndexedSymbol[];
  content: string;
  scannable: boolean;
}

export async function indexWorkspaceFiles(
  client: GraphClient,
  rootDir: string,
  options?: FileIndexerOptions
): Promise<{ indexedFiles: number; indexedSymbols: number; indexedReferences: number }> {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;

  const files = walkFiles(rootDir, includeExtensions);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const parsed: ParsedFile[] = [];

  for (const file of files) {
    const stat = statSync(file);
    if (stat.size > maxFileSizeBytes) {
      continue;
    }

    const relPath = normalizePath(relative(rootDir, file));
    const content = readFileSync(file, "utf8");
    const fileNodeId = `file:${relPath}`;
    const moduleNodeId = `module:${moduleKey(relPath)}`;
    const indexer = getIndexerForFile(relPath);
    const language = indexer?.language ?? (extOf(relPath).replace(/^\./, "") || "text");

    let declared: IndexedSymbol[] = [];
    let imports: string[] = [];

    if (indexer) {
      const extracted = indexer.extract(relPath, content);
      declared = extracted.symbols.map((sym) => ({
        ...sym,
        nodeId: `symbol:${relPath}:${hashText(sym.name)}`,
      }));
      imports = extracted.imports.map((imp) => imp.module);
    }

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
        sizeBytes: stat.size,
      },
    });
    nodes.push({ id: moduleNodeId, type: "Module", content: moduleKey(relPath) });
    edges.push({ from: fileNodeId, to: moduleNodeId, relation: "depends_on" });

    for (const symbol of declared) {
      const sig = `${symbol.kind} ${symbol.name}${symbol.exported ? " (exported)" : ""} @${relPath}:${symbol.line}`;
      nodes.push({
        id: symbol.nodeId,
        type: "Symbol",
        content: sig,
        metadata: {
          name: symbol.name,
          kind: symbol.kind,
          exported: symbol.exported,
          line: symbol.line,
          file: relPath,
        },
      });
      edges.push({ from: fileNodeId, to: symbol.nodeId, relation: "defines" });
    }

    for (const target of imports) {
      const targetModule = normalizeImportTarget(target);
      if (!targetModule) {
        continue;
      }
      const importNodeId = `module:${targetModule}`;
      nodes.push({ id: importNodeId, type: "Module", content: targetModule });
      edges.push({ from: moduleNodeId, to: importNodeId, relation: "imports" });
    }

    parsed.push({
      relPath,
      fileNodeId,
      moduleNodeId,
      declared,
      content,
      scannable: Boolean(indexer),
    });
  }

  const symbolIndex = new Map<string, IndexedSymbol[]>();
  for (const file of parsed) {
    for (const symbol of file.declared) {
      const list = symbolIndex.get(symbol.name) ?? [];
      list.push(symbol);
      symbolIndex.set(symbol.name, list);
    }
  }

  const identifierRe = /\b\w{3,}\b/g;
  let referenceCount = 0;
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

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));

  return {
    indexedFiles: nodes.filter((node) => node.type === "File").length,
    indexedSymbols: nodes.filter((node) => node.type === "Symbol").length,
    indexedReferences: referenceCount,
  };
}

function walkFiles(rootDir: string, includeExtensions: string[]): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }

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

function normalizeImportTarget(target: string): string | undefined {
  const cleaned = target
    .replace(/\\/g, "/")
    .replace(/\.(ts|tsx|js|jsx|py|rs|go|hpp|hxx|cpp|cxx|cc|h|c)$/i, "");
  if (!cleaned) {
    return undefined;
  }
  return cleaned;
}

function moduleKey(relPath: string): string {
  return relPath.replace(/\.(ts|tsx|js|jsx|md|json|py|rs|go|hpp|hxx|cpp|cxx|cc|h|c)$/i, "");
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

function extOf(relPath: string): string {
  const idx = relPath.lastIndexOf(".");
  if (idx < 0) {
    return "";
  }
  return relPath.slice(idx).toLowerCase();
}

