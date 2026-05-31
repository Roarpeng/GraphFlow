import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

export interface FileIndexerOptions {
  includeExtensions?: string[];
  maxFileSizeBytes?: number;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".md", ".json"];
const DEFAULT_MAX_FILE_SIZE = 200_000;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const REFERENCE_SKIPLIST = new Set([
  "if", "for", "let", "const", "var", "this", "new", "return", "true", "false",
  "null", "undefined", "console", "process", "require", "module", "exports",
  "import", "export", "default", "async", "await", "function", "class",
  "interface", "type", "enum", "from", "as", "of", "in", "do", "while",
  "switch", "case", "break", "continue", "throw", "try", "catch", "finally",
  "void", "yield", "number", "string", "boolean", "object", "any", "unknown",
  "never", "Array", "Promise", "Map", "Set", "Date", "Error", "JSON", "Math",
  "Object", "String", "Number", "Boolean", "Symbol", "Function", "RegExp",
]);

interface DeclaredSymbol {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
  nodeId: string;
}

interface ParsedFile {
  relPath: string;
  fileNodeId: string;
  moduleNodeId: string;
  declared: DeclaredSymbol[];
  imports: string[];
  identifiers: Array<{ name: string }>;
  isCodeFile: boolean;
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
    nodes.push({ id: fileNodeId, type: "File", content: relPath });
    nodes.push({ id: moduleNodeId, type: "Module", content: moduleKey(relPath) });
    edges.push({ from: fileNodeId, to: moduleNodeId, relation: "depends_on" });

    const ext = extOf(relPath);
    const isCodeFile = TS_EXTENSIONS.has(ext);

    let declared: DeclaredSymbol[] = [];
    let imports: string[] = [];
    let identifiers: Array<{ name: string }> = [];

    if (isCodeFile) {
      try {
        const extracted = extractFromAst(relPath, content);
        declared = extracted.declared;
        imports = extracted.imports;
        identifiers = extracted.identifiers;
      } catch {
        declared = fallbackDeclared(relPath, content);
        imports = fallbackImports(content);
        identifiers = [];
      }
    }

    for (const symbol of declared) {
      nodes.push({
        id: symbol.nodeId,
        type: "Symbol",
        content: `${relPath}::${symbol.name} ${JSON.stringify({
          name: symbol.name,
          kind: symbol.kind,
          exported: symbol.exported,
          line: symbol.line,
        })}`,
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

    parsed.push({ relPath, fileNodeId, moduleNodeId, declared, imports, identifiers, isCodeFile });
  }

  const symbolIndex = new Map<string, DeclaredSymbol[]>();
  for (const file of parsed) {
    for (const symbol of file.declared) {
      const list = symbolIndex.get(symbol.name) ?? [];
      list.push(symbol);
      symbolIndex.set(symbol.name, list);
    }
  }

  let referenceCount = 0;
  for (const file of parsed) {
    if (!file.isCodeFile) {
      continue;
    }
    const ownNames = new Set(file.declared.map((s) => s.name));
    const seenThisFile = new Set<string>();
    for (const ident of file.identifiers) {
      const name = ident.name;
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

function extractFromAst(
  relPath: string,
  content: string
): { declared: DeclaredSymbol[]; imports: string[]; identifiers: Array<{ name: string }> } {
  const ext = extOf(relPath);
  const scriptKind =
    ext === ".tsx" ? ts.ScriptKind.TSX :
    ext === ".jsx" ? ts.ScriptKind.JSX :
    ext === ".js" ? ts.ScriptKind.JS :
    ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    relPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const declared: DeclaredSymbol[] = [];
  const imports: string[] = [];
  const identifiers: Array<{ name: string }> = [];
  const declNamePositions = new Set<number>();

  const addDecl = (
    nameNode: ts.Node | undefined,
    kind: string,
    exported: boolean
  ): void => {
    if (!nameNode || !ts.isIdentifier(nameNode)) {
      return;
    }
    const name = nameNode.text;
    if (!name) {
      return;
    }
    const start = nameNode.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    declared.push({
      name,
      kind,
      exported,
      line: line + 1,
      nodeId: `symbol:${relPath}:${hashText(name)}`,
    });
    declNamePositions.add(start);
  };

  const hasExport = (node: ts.Node): boolean => {
    const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
    return (flags & ts.ModifierFlags.Export) !== 0;
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      addDecl(stmt.name, "function", hasExport(stmt));
    } else if (ts.isClassDeclaration(stmt)) {
      addDecl(stmt.name, "class", hasExport(stmt));
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          addDecl(member.name, "method", false);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      addDecl(stmt.name, "interface", hasExport(stmt));
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      addDecl(stmt.name, "type", hasExport(stmt));
    } else if (ts.isEnumDeclaration(stmt)) {
      addDecl(stmt.name, "enum", hasExport(stmt));
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExport(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          addDecl(decl.name, "variable", exported);
        }
      }
    } else if (ts.isImportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        imports.push(spec.text);
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        imports.push(spec.text);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "require" && node.arguments.length > 0) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          imports.push(arg.text);
        }
      }
    }
    if (ts.isIdentifier(node) && !declNamePositions.has(node.getStart(sourceFile))) {
      const text = node.text;
      if (text) {
        identifiers.push({ name: text });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return { declared, imports, identifiers };
}

function fallbackDeclared(relPath: string, content: string): DeclaredSymbol[] {
  const lines = content.split(/\r?\n/);
  const out: DeclaredSymbol[] = [];
  for (let i = 0; i < lines.length && out.length < 80; i += 1) {
    const trimmed = lines[i]?.trim() ?? "";
    if (trimmed.startsWith("export ") || trimmed.startsWith("function ")) {
      const summary = trimmed.slice(0, 200);
      out.push({
        name: summary,
        kind: "raw",
        exported: trimmed.startsWith("export "),
        line: i + 1,
        nodeId: `symbol:${relPath}:${hashText(summary)}`,
      });
    }
  }
  return out;
}

function fallbackImports(content: string): string[] {
  const matches = content.matchAll(/(?:import\s+[^"']+from\s+|require\()\s*["']([^"']+)["']/g);
  const targets: string[] = [];
  for (const match of matches) {
    const target = match[1]?.trim();
    if (target) {
      targets.push(target);
    }
  }
  return targets.slice(0, 120);
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
  const cleaned = target.replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx)$/i, "");
  if (!cleaned) {
    return undefined;
  }
  return cleaned;
}

function moduleKey(relPath: string): string {
  return relPath.replace(/\.(ts|tsx|js|jsx|md|json)$/i, "");
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
