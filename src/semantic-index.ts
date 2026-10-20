/**
 * GraphFlow — L0 workspace semantic index (`src/semantic-index.ts`)
 *
 * A cached, dependency-free semantic layer over the existing per-file AST analyses:
 *
 *   1. Module graph       – resolved imports (+ tsconfig/jsconfig baseUrl/paths aliases),
 *                           barrel/re-export edges (`export *`, `export {A} from`).
 *   2. Symbol table       – name -> declarations {file, kind, parentClass, signature, line…}
 *                           with import-alias and re-export aware lookup.
 *   3. Type environment   – per-file receiver types from the same inference used by blast
 *                           radius (annotations, new/constructor, params, fields, assignments,
 *                           last-write-in-block, branch conflicts -> unknown, generics/arrays/
 *                           nullable unwrap, inherited classes).
 *   4. Call resolution    – each call site -> {targetFile, targetSymbol, parentClass,
 *                           confidence, reason}, or an explicit unresolved/ambiguous answer.
 *
 * The index is best-effort and NEVER guesses when a call target is not provable: callers
 * keep their existing heuristic fallbacks for unresolved calls. It is cached per workspace
 * root and invalidated incrementally via file mtime+size+content-hash fingerprints.
 *
 * No new runtime dependencies; this module only imports ast-engine and lazily resolves the
 * workspace index through `slicer` to avoid an import cycle.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";import {
  createWorkspaceTypeHierarchy,
  inImplicitPackageScope,
  inferReceiverTypeIndex,
  resolveRelativeImportPath,
  resolveReceiverType,
  sourceLanguageFamily,
  unwrapTypeExpression,
  type AstCallSite,
  type FileAstAnalysis,
  type ReceiverTypeIndex,
  type SourceLanguageFamily,
  type SymbolKind,
  type WorkspaceTypeHierarchy,
  type WorkspaceTypeHierarchySource,
} from "./ast-engine.js";

const requireFn = createRequire(__filename);

/** Workspace cache shape used by the semantic index (structurally compatible with slicer). */
export interface SemanticWorkspaceSource extends WorkspaceTypeHierarchySource {
  getFiles(forceRescan?: boolean): string[];
  getFileSet(): ReadonlySet<string>;
  getRawFile(relPath: string): { content: string; size: number; mtimeMs: number } | undefined;
  getFileAnalysis(relPath: string): { content: string; ast: FileAstAnalysis; size: number } | undefined;
}

interface SlicerModule {
  getWorkspaceAstIndex(rootDir: string): SemanticWorkspaceSource;
}

function loadWorkspaceIndex(rootDir: string): SemanticWorkspaceSource {
  let slicer: SlicerModule;
  try {
    slicer = requireFn("./slicer.js") as SlicerModule;
  } catch {
    // tsx source execution resolves the TS module instead of the build output.
    slicer = requireFn("./slicer.ts") as SlicerModule;
  }
  return slicer.getWorkspaceAstIndex(rootDir);
}

// ── Public data model ───────────────────────────────────────────────────────

export interface SemanticSymbolDecl {
  file: string;
  name: string;
  kind: SymbolKind;
  parentClass?: string;
  signature: string;
  line: number;
  endLine: number;
  exported: boolean;
  returnType?: string;
  /** First line of the definition body; absent for body-less declarations/prototypes. */
  bodyStartLine?: number;
}

export interface SemanticImportEdge {
  module: string;
  line: number;
  raw: string;
  importedNames: string[];
  resolvedFile?: string;
  /** local name -> imported name (import aliases, e.g. `import {A as B}` -> B:A). */
  aliases: Record<string, string>;
  /** exported name -> source name for re-exports (`export {A as B} from` -> B:A). */
  reexportedAs: Record<string, string>;
  reexport: boolean;
}

export interface SemanticModuleNode {
  file: string;
  language: SourceLanguageFamily;
  imports: SemanticImportEdge[];
  reexports: SemanticImportEdge[];
  /** Resolved files reached by `export * from` / `export * as ns from`. */
  exportAllFrom: string[];
  aliases: Record<string, string>;
  /** Declared namespaces (C# `namespace A.B;` / `namespace A.B { ... }`; empty elsewhere). */
  namespaces: string[];
}

export type SemanticResolutionReason =
  | "same-file"
  | "imported-symbol"
  | "barrel-reexport"
  | "method-on-receiver"
  | "inherited-method"
  | "factory-return"
  | "implicit-package"
  | "constructor"
  | "unique-workspace"
  | "declaration"
  | "unresolved-receiver"
  | "ambiguous"
  | "unknown";

export interface SemanticResolvedCall {
  callFile: string;
  line: number;
  callee: string;
  targetFile?: string;
  targetSymbol?: string;
  parentClass?: string;
  /** 0 = unknown, 1 = directly declared on the resolved receiver type. */
  confidence: number;
  reason: SemanticResolutionReason;
}

export interface SemanticIndexStats {
  files: number;
  modules: number;
  declarations: number;
  buildTimeMs: number;
  queries: number;
}

export interface SemanticIndex {
  readonly rootDir: string;
  getFiles(): readonly string[];
  getModuleGraph(): ReadonlyMap<string, SemanticModuleNode>;
  /** Namespace -> declaring files (C# namespace/using resolution; empty for other languages). */
  getNamespaceMap(): ReadonlyMap<string, readonly string[]>;
  getTypeEnvironment(file: string): ReadonlyMap<string, string>;
  getHierarchy(): WorkspaceTypeHierarchy;
  findDeclarations(name: string): readonly SemanticSymbolDecl[];
  getDeclarationsInFile(file: string): readonly SemanticSymbolDecl[];
  resolveImport(fromFile: string, moduleSpecifier: string): string | undefined;
  resolveExportedSymbol(file: string, exportedName: string): SemanticSymbolDecl | undefined;
  resolveImportedSymbol(
    fromFile: string,
    localName: string
  ): { decl: SemanticSymbolDecl; via: "alias" | "symbol" | "barrel" | "namespace" } | undefined;
  resolveMethod(
    className: string,
    methodName: string,
    fromFile?: string
  ): { decl: SemanticSymbolDecl; confidence: number; reason: SemanticResolutionReason } | undefined;
  resolveCall(callFile: string, call: AstCallSite): SemanticResolvedCall;
  invalidate(file?: string): void;
  rebuild(): void;
  stats(): SemanticIndexStats;
}

/**
 * Minimum confidence at which a resolved call target is treated as authoritative.
 * Below it, callers fall back to their language-scoped heuristic guards.
 */
export const SEMANTIC_CONFIDENCE_MIN = 0.75;

// ── Internal file entry ─────────────────────────────────────────────────────

interface SemanticFileEntry {
  file: string;
  /** `mtimeMs:size` freshness fingerprint (cheap hot-path check). */
  state: string;
  /** Content hash captured at build time (guards same-size/same-mtime rewrites). */
  contentHash: string;
  ast: FileAstAnalysis;
  content: string;
  module: SemanticModuleNode;
  receiverIndex: ReceiverTypeIndex;
  decls: SemanticSymbolDecl[];
  /** Declared namespaces (C#), used for `using` -> file resolution. */
  namespaces: string[];
}

interface AliasPattern {
  pattern: string;
  targets: string[];
}

interface AliasConfig {
  patterns: AliasPattern[];
  baseDir: string;
}

const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "class",
  "struct",
  "interface",
  "type",
  "enum",
]);

function isTypeKind(kind: SymbolKind): boolean {
  return TYPE_KINDS.has(kind);
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

const CS_NAMESPACE_DECL_RE = /(?:^|[{};])\s*namespace\s+([A-Za-z_][\w.]*)/g;

/** Declared namespaces for a file (C# only): `namespace A.B;` and block form `namespace A.B {`. */
function extractNamespaces(file: string, content: string): string[] {
  if (extname(file).toLowerCase() !== ".cs") return [];
  const out: string[] = [];
  for (const match of content.matchAll(CS_NAMESPACE_DECL_RE)) {
    const namespace = match[1];
    if (namespace && !out.includes(namespace)) out.push(namespace);
  }
  return out;
}

/** Strips `//` and `/* *\/` comments plus trailing commas from JSONC config text. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1] ?? "";
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const ALIAS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function firstTopLevelTypeArg(inner: string): string {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "<" || ch === "[" || ch === "(") depth += 1;
    else if (ch === ">" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if ((ch === "," || ch === "|") && depth === 0) return inner.slice(0, i).trim();
  }
  return inner.trim();
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "<" || ch === "[" || ch === "(" || ch === "{") depth += 1;
    else if (ch === ">" || ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// ── Return-type extraction (for factory-call receiver inference) ────────────

function returnTypeFromSignature(
  signature: string,
  file: string,
  declaredReturnType?: string
): string | undefined {
  if (declaredReturnType) {
    const unwrapped = unwrapTypeExpression(declaredReturnType);
    if (unwrapped) return unwrapped;
  }
  const ext = extname(file).toLowerCase();
  if (ext === ".py" || ext === ".pyi" || ext === ".rs") {
    const arrow = signature.match(/->\s*([^:{]+)/);
    if (arrow) return unwrapTypeExpression(arrow[1]);
  }
  if (ext === ".go") {
    const close = signature.lastIndexOf(")");
    if (close >= 0) {
      const rest = signature.slice(close + 1).replace(/\{[\s\S]*$/, "").trim();
      if (rest) return unwrapTypeExpression(firstTopLevelTypeArg(rest));
    }
  }
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    const arrowReturn = signature.match(/\)\s*:\s*([A-Za-z_$][\w$<>,. |[\]]*?)\s*(?:=>|\{)/);
    if (arrowReturn) return unwrapTypeExpression(arrowReturn[1]);
  }
  // C-family: `[qualifiers] ReturnType [Class::]name(params)`.
  const paren = signature.indexOf("(");
  if (paren > 0) {
    const before = signature
      .slice(0, paren)
      .replace(/[A-Za-z_][\w:]*(?:\s*<[^<>]*>)?\s*$/, "")
      .trim();
    if (before) {
      const candidate = before.replace(/^(?:static|inline|virtual|explicit|constexpr|extern|async)\s+/g, "");
      const unwrapped = unwrapTypeExpression(candidate);
      if (unwrapped) return unwrapped;
    }
  }
  return undefined;
}

// ── Index implementation ────────────────────────────────────────────────────

class SemanticIndexImpl implements SemanticIndex {
  readonly rootDir: string;
  private readonly workspace: SemanticWorkspaceSource;
  private entries = new Map<string, SemanticFileEntry>();
  private declsByName = new Map<string, SemanticSymbolDecl[]>();
  private moduleGraph = new Map<string, SemanticModuleNode>();
  private fileStates = new Map<string, string>();
  private namespaceToFiles = new Map<string, string[]>();
  private hierarchyCache: WorkspaceTypeHierarchy | null = null;
  private aliasConfigCache: AliasConfig | null | undefined;
  private buildTimeMs = 0;
  private queries = 0;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.workspace = loadWorkspaceIndex(rootDir);
    this.ensureFresh();
  }

  private ensureFresh(): void {
    const files = this.workspace.getFiles().slice().sort();
    const present = new Set(files);
    let changed = false;
    for (const existing of Array.from(this.entries.keys())) {
      if (!present.has(existing)) {
        this.removeEntry(existing);
        changed = true;
      }
    }
    const startedAt = Date.now();
    const pending: Array<{ file: string; state: string; contentHash: string }> = [];
    for (const file of files) {
      const raw = this.workspace.getRawFile(file);
      if (!raw) continue;
      const state = `${raw.mtimeMs}:${raw.size}`;
      if (this.entries.get(file)?.state === state) continue;
      // Content hash is captured on (re)build; it only needs to run when the cheap
      // mtime+size fingerprint changes, keeping warm queries cheap.
      pending.push({ file, state, contentHash: fnv1a(raw.content) });
    }
    for (const change of pending) {
      this.buildFile(change.file, change.state, change.contentHash);
      changed = true;
    }
    if (changed) {
      // Namespace/import resolution needs the full namespace map, so (re)build module nodes
      // in a second pass once every pending file has registered its namespaces.
      for (const [file, entry] of Array.from(this.entries.entries())) {
        const moduleNode = this.buildModuleNode(
          file,
          entry.module.language,
          entry.ast,
          entry.namespaces
        );
        entry.module = moduleNode;
        this.moduleGraph.set(file, moduleNode);
      }
      this.buildTimeMs += Date.now() - startedAt;
      this.hierarchyCache = null;
    }
  }

  private removeEntry(file: string): void {
    const entry = this.entries.get(file);
    if (!entry) return;
    for (const decl of entry.decls) {
      const list = this.declsByName.get(decl.name);
      if (!list) continue;
      const next = list.filter((candidate) => candidate !== decl);
      if (next.length > 0) this.declsByName.set(decl.name, next);
      else this.declsByName.delete(decl.name);
    }
    this.unregisterNamespaces(file);
    this.entries.delete(file);
    this.moduleGraph.delete(file);
    this.fileStates.delete(file);
    this.hierarchyCache = null;
  }

  private registerNamespaces(file: string, namespaces: readonly string[]): void {
    for (const namespace of namespaces) {
      const files = this.namespaceToFiles.get(namespace) ?? [];
      if (!files.includes(file)) files.push(file);
      files.sort();
      this.namespaceToFiles.set(namespace, files);
    }
  }

  private unregisterNamespaces(file: string): void {
    for (const [namespace, files] of Array.from(this.namespaceToFiles.entries())) {
      const next = files.filter((candidate) => candidate !== file);
      if (next.length > 0) this.namespaceToFiles.set(namespace, next);
      else this.namespaceToFiles.delete(namespace);
    }
  }

  private buildFile(file: string, state: string, contentHash: string): void {
    this.removeEntry(file);
    const data = this.workspace.getFileAnalysis(file);
    if (!data) return;
    const { ast, content } = data;
    const language = sourceLanguageFamily(file);
    const namespaces = extractNamespaces(file, content);
    this.registerNamespaces(file, namespaces);
    const moduleNode = this.buildModuleNode(file, language, ast, namespaces);
    const decls: SemanticSymbolDecl[] = ast.symbols.map((symbol) => ({
      file,
      name: symbol.name,
      kind: symbol.kind,
      ...(symbol.parentClass ? { parentClass: symbol.parentClass } : {}),
      signature: symbol.signature,
      line: symbol.line,
      endLine: symbol.endLine,
      exported: symbol.exported,
      ...(symbol.returnType ? { returnType: symbol.returnType } : {}),
      ...(symbol.bodyStartLine !== undefined ? { bodyStartLine: symbol.bodyStartLine } : {}),
    }));
    const entry: SemanticFileEntry = {
      file,
      state,
      contentHash,
      ast,
      content,
      module: moduleNode,
      receiverIndex: inferReceiverTypeIndex(file, content, ast),
      decls,
      namespaces,
    };
    this.entries.set(file, entry);
    this.moduleGraph.set(file, moduleNode);
    this.fileStates.set(file, state);
    for (const decl of decls) {
      const list = this.declsByName.get(decl.name) ?? [];
      list.push(decl);
      this.declsByName.set(decl.name, list);
    }
    this.hierarchyCache = null;
  }

  private aliasConfig(): AliasConfig | undefined {
    if (this.aliasConfigCache !== undefined) return this.aliasConfigCache ?? undefined;
    const configs = [join(this.rootDir, "tsconfig.json"), join(this.rootDir, "jsconfig.json")];
    let result: AliasConfig | undefined;
    for (const configPath of configs) {
      if (!existsSync(configPath)) continue;
      try {
        const parsed = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8"))) as {
          compilerOptions?: {
            baseUrl?: string;
            paths?: Record<string, string[]>;
          };
        };
        const options = parsed.compilerOptions ?? {};
        const paths = options.paths ?? {};
        const patterns: AliasPattern[] = [];
        for (const [pattern, targets] of Object.entries(paths)) {
          if (!Array.isArray(targets) || targets.length === 0) continue;
          patterns.push({ pattern, targets: targets.filter((target) => typeof target === "string") });
        }
        if (patterns.length > 0) {
          result = {
            baseDir: resolve(this.rootDir, options.baseUrl ?? "."),
            patterns,
          };
        }
        break;
      } catch {
        // Invalid/JSONC-unparseable config: alias resolution stays disabled.
      }
    }
    this.aliasConfigCache = result ?? null;
    return result;
  }

  private resolveAlias(spec: string, fileSet: ReadonlySet<string>): string | undefined {
    const config = this.aliasConfig();
    if (!config) return undefined;
    const tryCandidate = (absoluteTarget: string): string | undefined => {
      const relativeTarget = relative(this.rootDir, absoluteTarget).replace(/\\/g, "/");
      if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) return undefined;
      const candidates = [
        relativeTarget,
        ...ALIAS_EXTENSIONS.map((ext) => `${relativeTarget}${ext}`),
        ...ALIAS_EXTENSIONS.map((ext) => `${relativeTarget}/index${ext}`),
      ];
      for (const candidate of candidates) {
        const normalized = candidate.replace(/\\/g, "/");
        if (fileSet.has(normalized)) return normalized;
      }
      return undefined;
    };
    for (const { pattern, targets } of config.patterns) {
      const starIndex = pattern.indexOf("*");
      if (starIndex >= 0) {
        const prefix = pattern.slice(0, starIndex);
        const suffix = pattern.slice(starIndex + 1);
        if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
        const wildcard = spec.slice(prefix.length, spec.length - suffix.length);
        for (const target of targets) {
          const targetPath = target.replace("*", wildcard);
          const found = tryCandidate(join(config.baseDir, targetPath));
          if (found) return found;
        }
      } else if (pattern === spec) {
        for (const target of targets) {
          const found = tryCandidate(join(config.baseDir, target));
          if (found) return found;
        }
      }
    }
    return undefined;
  }

  private resolveModuleSpecifier(fromFile: string, moduleSpecifier: string): string | undefined {
    const fileSet = this.workspace.getFileSet();
    const direct = resolveRelativeImportPath(
      this.rootDir,
      fromFile,
      moduleSpecifier,
      fileSet
    );
    if (direct) return direct;
    const alias = this.resolveAlias(moduleSpecifier, fileSet);
    if (alias) return alias;
    if (sourceLanguageFamily(fromFile) === "csharp") {
      return this.resolveCSharpModule(fromFile, moduleSpecifier);
    }
    return undefined;
  }

  /**
   * C# `using` targets a namespace, not a file path. Resolve through the namespace map built
   * from parsed namespace declarations; fall back to a file-stem match for name==namespace
   * conventions (`using Demo.Base;` -> Base.cs). Same-directory candidates win.
   */
  private resolveCSharpModule(fromFile: string, moduleSpecifier: string): string | undefined {
    const namespace = moduleSpecifier.replace(/^global::\s*/, "").trim();
    const namespaceFiles = this.namespaceToFiles.get(namespace);
    if (namespaceFiles && namespaceFiles.length > 0) {
      return (
        namespaceFiles.find((candidate) => dirname(candidate) === dirname(fromFile)) ??
        namespaceFiles[0]
      );
    }
    const leaf = namespace.split(".").pop();
    if (!leaf) return undefined;
    let fallback: string | undefined;
    for (const candidate of this.workspace.getFiles()) {
      if (candidate === fromFile) continue;
      if (sourceLanguageFamily(candidate) !== "csharp") continue;
      if (basename(candidate).replace(/\.cs$/i, "").toLowerCase() !== leaf.toLowerCase()) continue;
      if (dirname(candidate) === dirname(fromFile)) return candidate;
      fallback ??= candidate;
    }
    return fallback;
  }

  /** True when `candidateFile` declares a namespace imported by `fromFile` (C# `using`). */
  private isInImportedNamespace(fromFile: string, candidateFile: string): boolean {
    const entry = this.entries.get(fromFile);
    if (!entry || entry.module.language !== "csharp") return false;
    for (const edge of entry.module.imports) {
      const namespace = edge.module.replace(/^global::\s*/, "").trim();
      const files = this.namespaceToFiles.get(namespace);
      if (files?.includes(candidateFile)) return true;
    }
    return false;
  }

  private buildModuleNode(
    file: string,
    language: SourceLanguageFamily,
    ast: FileAstAnalysis,
    namespaces: readonly string[] = []
  ): SemanticModuleNode {
    const imports: SemanticImportEdge[] = [];
    const reexports: SemanticImportEdge[] = [];
    const exportAllFrom: string[] = [];
    const aliases: Record<string, string> = {};

    for (const rawImport of ast.imports) {
      const raw = rawImport.raw ?? "";
      const resolvedFile = this.resolveModuleSpecifier(file, rawImport.module);
      const isReexport = language === "js" && /^export\b/.test(raw.trim());
      const edge: SemanticImportEdge = {
        module: rawImport.module,
        line: rawImport.line,
        raw,
        importedNames: rawImport.importedNames,
        ...(resolvedFile ? { resolvedFile } : {}),
        aliases: {},
        reexportedAs: {},
        reexport: isReexport,
      };
      if (language === "js") {
        const braced = raw.match(/\{([^}]*)\}/);
        if (braced) {
          for (const part of splitTopLevel(braced[1] ?? "", ",")) {
            const pair = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
            if (!pair) continue;
            const sourceName = pair[1]!;
            const localOrExported = pair[2];
            if (isReexport) {
              edge.reexportedAs[localOrExported ?? sourceName] = sourceName;
            } else if (localOrExported) {
              edge.aliases[localOrExported] = sourceName;
              aliases[localOrExported] = sourceName;
            }
          }
        }
        if (isReexport && /\bexport\s+\*\s+from\b/.test(raw) && resolvedFile) {
          exportAllFrom.push(resolvedFile);
        }
      } else if (language === "python") {
        const aliasMatches = raw.matchAll(/([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)/g);
        for (const match of aliasMatches) {
          const sourceName = match[1]!;
          const local = match[2]!;
          edge.aliases[local] = sourceName;
          aliases[local] = sourceName;
        }
      } else if (language === "csharp") {
        const aliasMatch = raw.match(/^using\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)/);
        if (aliasMatch) {
          const local = aliasMatch[1]!;
          const target = aliasMatch[2]!.split(".").pop() ?? aliasMatch[2]!;
          edge.aliases[local] = target;
          aliases[local] = target;
        }
      }
      if (isReexport) reexports.push(edge);
      else imports.push(edge);
    }

    return {
      file,
      language,
      imports,
      reexports,
      exportAllFrom,
      aliases,
      namespaces: [...namespaces],
    };
  }

  private entry(file: string): SemanticFileEntry | undefined {
    this.ensureFresh();
    return this.entries.get(file);
  }

  getFiles(): readonly string[] {
    this.ensureFresh();
    return Array.from(this.entries.keys()).sort();
  }

  getModuleGraph(): ReadonlyMap<string, SemanticModuleNode> {
    this.ensureFresh();
    return new Map(this.moduleGraph);
  }

  getNamespaceMap(): ReadonlyMap<string, readonly string[]> {
    this.ensureFresh();
    const snapshot = new Map<string, readonly string[]>();
    for (const [namespace, files] of this.namespaceToFiles) snapshot.set(namespace, [...files]);
    return snapshot;
  }

  getTypeEnvironment(file: string): ReadonlyMap<string, string> {
    this.queries += 1;
    return new Map(this.entry(file)?.receiverIndex.byName ?? []);
  }

  getHierarchy(): WorkspaceTypeHierarchy {
    this.ensureFresh();
    if (!this.hierarchyCache) {
      this.hierarchyCache = createWorkspaceTypeHierarchy(this.workspace);
    }
    return this.hierarchyCache;
  }

  findDeclarations(name: string): readonly SemanticSymbolDecl[] {
    this.queries += 1;
    this.ensureFresh();
    return (this.declsByName.get(name) ?? []).slice();
  }

  getDeclarationsInFile(file: string): readonly SemanticSymbolDecl[] {
    this.queries += 1;
    return this.entry(file)?.decls.slice() ?? [];
  }

  resolveImport(fromFile: string, moduleSpecifier: string): string | undefined {
    this.queries += 1;
    this.ensureFresh();
    return this.resolveModuleSpecifier(fromFile, moduleSpecifier);
  }

  resolveExportedSymbol(
    file: string,
    exportedName: string,
    visited: Set<string> = new Set(),
    depth = 0
  ): SemanticSymbolDecl | undefined {
    if (depth > 8) return undefined;
    const visitedKey = `${file}#${exportedName}`;
    if (visited.has(visitedKey)) return undefined;
    visited.add(visitedKey);
    this.ensureFresh();
    const entry = this.entries.get(file);
    if (!entry) return undefined;
    const direct =
      entry.decls.find((decl) => decl.name === exportedName && decl.exported) ??
      entry.decls.find((decl) => decl.name === exportedName);
    if (direct) return direct;

    // Explicit re-exports: `export {A as B} from './x'`.
    for (const edge of entry.module.reexports) {
      if (!edge.resolvedFile) continue;
      const sourceName = edge.reexportedAs[exportedName];
      const candidates: string[] = [];
      if (sourceName) candidates.push(sourceName);
      if (edge.importedNames.includes(exportedName)) candidates.push(exportedName);
      for (const candidate of candidates) {
        const found = this.resolveExportedSymbol(edge.resolvedFile, candidate, visited, depth + 1);
        if (found) return found;
      }
    }
    // `export * from './x'` barrels.
    for (const reexportedFile of entry.module.exportAllFrom) {
      const found = this.resolveExportedSymbol(reexportedFile, exportedName, visited, depth + 1);
      if (found) return found;
    }
    // Default export: fall back to the single exported type declaration of the file.
    if (exportedName === "default") {
      const exportedTypes = entry.decls.filter((decl) => decl.exported && isTypeKind(decl.kind));
      if (exportedTypes.length === 1) return exportedTypes[0];
    }
    return undefined;
  }

  resolveImportedSymbol(
    fromFile: string,
    localName: string
  ): { decl: SemanticSymbolDecl; via: "alias" | "symbol" | "barrel" | "namespace" } | undefined {
    this.queries += 1;
    const entry = this.entry(fromFile);
    if (!entry) return undefined;
    for (const edge of entry.module.imports) {
      if (!edge.resolvedFile) continue;
      const aliasedSource = edge.aliases[localName];
      if (aliasedSource) {
        const decl = this.resolveExportedSymbol(edge.resolvedFile, aliasedSource);
        if (decl) return { decl, via: "alias" };
      }
      if (edge.importedNames.includes(localName)) {
        const decl = this.resolveExportedSymbol(edge.resolvedFile, localName);
        if (decl) return { decl, via: "symbol" };
      }
      // Wildcard imports (`import * as m`, `#include`, `from x import *`) never bind a
      // specific symbol here — barrel resolution is handled by resolveExportedSymbol and the
      // language-specific implicit-package scope by call resolution.
    }
    // C# `using Demo.Base;` imports a namespace: search every file declaring that namespace.
    if (entry.module.language === "csharp") {
      for (const edge of entry.module.imports) {
        const namespace = edge.module.replace(/^global::\s*/, "").trim();
        for (const namespaceFile of this.namespaceToFiles.get(namespace) ?? []) {
          if (namespaceFile === fromFile) continue;
          const decl = this.resolveExportedSymbol(namespaceFile, localName);
          if (decl) return { decl, via: "namespace" };
        }
      }
    }
    return undefined;
  }

  resolveMethod(
    className: string,
    methodName: string,
    fromFile?: string
  ): { decl: SemanticSymbolDecl; confidence: number; reason: SemanticResolutionReason } | undefined {
    this.queries += 1;
    this.ensureFresh();
    const family = fromFile ? sourceLanguageFamily(fromFile) : undefined;
    const matchesFamily = (decl: SemanticSymbolDecl): boolean =>
      family === undefined || sourceLanguageFamily(decl.file) === family;
    let classDecl: SemanticSymbolDecl | undefined;
    if (fromFile) {
      const local = this.entries
        .get(fromFile)
        ?.decls.find((decl) => decl.name === className && isTypeKind(decl.kind));
      if (local) classDecl = local;
      if (!classDecl) {
        const imported = this.resolveImportedSymbol(fromFile, className);
        if (imported && isTypeKind(imported.decl.kind)) classDecl = imported.decl;
      }
    }
    if (!classDecl) {
      // Language-family scoped lookup (a JS `Base` is not the Python/Rust/C/C# `Base`).
      const candidates = (this.declsByName.get(className) ?? []).filter(
        (decl) => isTypeKind(decl.kind) && matchesFamily(decl)
      );
      if (candidates.length === 0) return undefined;
      if (fromFile && family) {
        // Prefer the caller's package/namespace scope, then its directory.
        const scopeMatch = candidates.find((candidate) =>
          inImplicitPackageScope(fromFile, candidate.file, family)
        );
        const namespaceMatch = candidates.find((candidate) =>
          this.isInImportedNamespace(fromFile, candidate.file)
        );
        const dirMatch = candidates.find(
          (candidate) => dirname(candidate.file) === dirname(fromFile)
        );
        classDecl = scopeMatch ?? namespaceMatch ?? dirMatch;
      }
      if (!classDecl) {
        const uniqueFiles = new Set(candidates.map((candidate) => candidate.file));
        if (uniqueFiles.size > 1) return undefined;
        classDecl = candidates[0];
      }
    }
    if (!classDecl) return undefined;
    const resolvedClass: SemanticSymbolDecl = classDecl;
    const hierarchy = this.getHierarchy();
    let current: string | undefined = resolvedClass.name;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const candidates = (this.declsByName.get(methodName) ?? []).filter(
        (decl) =>
          decl.parentClass === current &&
          (decl.kind === "method" || decl.kind === "function") &&
          matchesFamily(decl)
      );
      if (candidates.length > 0) {
        // Prefer an in-workspace definition over a body-less prototype (C/C++ headers).
        const withBody = candidates.filter((candidate) => candidate.bodyStartLine !== undefined);
        const pool = withBody.length > 0 ? withBody : candidates;
        const preferred = pool.find((candidate) => candidate.file === resolvedClass.file) ?? pool[0]!;
        const direct = current === resolvedClass.name;
        return {
          decl: preferred,
          confidence: direct ? 0.95 : 0.9,
          reason: direct ? "method-on-receiver" : "inherited-method",
        };
      }
      const parent = hierarchy.parentOf(current);
      if (!parent) break;
      current = parent;
    }
    return undefined;
  }

  private resolveFunctionSymbol(
    fromFile: string,
    name: string
  ): SemanticSymbolDecl | undefined {
    const own = this.entries
      .get(fromFile)
      ?.decls.find((decl) => decl.name === name && decl.parentClass === undefined);
    if (own) return own;
    const imported = this.resolveImportedSymbol(fromFile, name);
    if (imported) return imported.decl;
    const candidates = (this.declsByName.get(name) ?? []).filter(
      (decl) => decl.parentClass === undefined
    );
    if (candidates.length === 1) return candidates[0];
    return undefined;
  }

  private implicitPackageDeclarations(fromFile: string, name: string): SemanticSymbolDecl[] {
    const family = sourceLanguageFamily(fromFile);
    const out: SemanticSymbolDecl[] = [];
    for (const decl of this.declsByName.get(name) ?? []) {
      if (decl.parentClass !== undefined) continue;
      if (decl.file === fromFile) continue;
      if (sourceLanguageFamily(decl.file) !== family) continue;
      if (!inImplicitPackageScope(fromFile, decl.file, family)) continue;
      if (decl.kind !== "function" && decl.kind !== "class" && decl.kind !== "struct") continue;
      out.push(decl);
    }
    return out;
  }

  /**
   * Go interfaces are structural: a call on a concrete receiver whose type declares the
   * same method set is an implementation call. Resolve it to the interface method
   * declaration so blast-radius / rename can see one logical symbol instead of N
   * unrelated concrete methods. Only activated for Go, and only when the interface
   * method is unambiguous.
   */
  private goInterfaceMethod(
    receiverType: string,
    methodName: string,
    fromFile: string
  ): SemanticSymbolDecl | undefined {
    if (sourceLanguageFamily(fromFile) !== "go") return undefined;
    const candidates = (this.declsByName.get(methodName) ?? []).filter(
      (decl) =>
        decl.kind === "method" &&
        decl.parentClass !== undefined &&
        sourceLanguageFamily(decl.file) === "go" &&
        this.isGoInterfaceName(decl.parentClass)
    );
    if (candidates.length === 0) return undefined;

    const direct = candidates.filter((candidate) => candidate.parentClass === receiverType);
    if (direct.length > 0) return this.pickGoInterfaceDecl(direct);

    const implementing = candidates.filter((candidate) => {
      const interfaceName = candidate.parentClass!;
      const required = this.goInterfaceMethods(interfaceName)
        .map((decl) => decl.name);
      if (required.length === 0 || !required.includes(methodName)) return false;
      return required.every((requiredName) =>
        (this.declsByName.get(requiredName) ?? []).some(
          (impl) =>
            impl.kind === "method" &&
            impl.parentClass === receiverType &&
            sourceLanguageFamily(impl.file) === "go"
        )
      );
    });
    const interfaceNames = new Set(implementing.map((candidate) => candidate.parentClass));
    if (interfaceNames.size !== 1) return undefined;
    return this.pickGoInterfaceDecl(implementing);
  }

  private isGoInterfaceName(name: string): boolean {
    return (this.declsByName.get(name) ?? []).some(
      (decl) => decl.kind === "interface" && sourceLanguageFamily(decl.file) === "go"
    );
  }

  /** All method declarations belonging to an interface (methods are indexed by their own name). */
  private goInterfaceMethods(interfaceName: string): SemanticSymbolDecl[] {
    const out: SemanticSymbolDecl[] = [];
    for (const entry of this.entries.values()) {
      for (const decl of entry.decls) {
        if (
          decl.kind === "method" &&
          decl.parentClass === interfaceName &&
          sourceLanguageFamily(decl.file) === "go"
        ) {
          out.push(decl);
        }
      }
    }
    return out;
  }

  private pickGoInterfaceDecl(
    candidates: readonly SemanticSymbolDecl[]
  ): SemanticSymbolDecl | undefined {
    return [...candidates].sort(
      (a, b) => a.file.length - b.file.length || a.file.localeCompare(b.file) || a.line - b.line
    )[0];
  }

  resolveCall(callFile: string, call: AstCallSite): SemanticResolvedCall {
    this.queries += 1;
    const entry = this.entry(callFile);
    const base: SemanticResolvedCall = {
      callFile,
      line: call.line,
      callee: call.callee,
      confidence: 0,
      reason: "unknown",
    };
    if (!entry) return base;
    if (call.isDeclaration) return { ...base, reason: "declaration" };

    if (call.member || call.receiver !== undefined) {
      let receiverType = resolveReceiverType(call, entry.ast, entry.receiverIndex);
      let reason: SemanticResolutionReason = "method-on-receiver";
      if (!receiverType && call.receiverCall) {
        const factory = this.resolveFunctionSymbol(callFile, call.receiverCall);
        const returnType = factory
          ? returnTypeFromSignature(factory.signature, factory.file, factory.returnType)
          : undefined;
        if (returnType) {
          receiverType = returnType;
          reason = "factory-return";
        }
      }
      // Go composite literals (`jsonBinding{}.BindBody(...)`) and package-qualified
      // receivers carry the type name directly; accept it when that type is declared in
      // the same Go package.
      if (
        !receiverType &&
        call.receiver &&
        sourceLanguageFamily(callFile) === "go"
      ) {
        const samePackageType = (this.declsByName.get(call.receiver) ?? []).some(
          (decl) =>
            isTypeKind(decl.kind) &&
            sourceLanguageFamily(decl.file) === "go" &&
            inImplicitPackageScope(callFile, decl.file, "go")
        );
        if (samePackageType) receiverType = call.receiver;
      }
      if (!receiverType) return { ...base, reason: "unresolved-receiver" };
      const resolved = this.resolveMethod(receiverType, call.callee, callFile);
      const interfaceMethod = this.goInterfaceMethod(receiverType, call.callee, callFile);
      if (!resolved && !interfaceMethod) return { ...base, reason: "unresolved-receiver" };
      const target = interfaceMethod ?? resolved!.decl;
      return {
        callFile,
        line: call.line,
        callee: call.callee,
        targetFile: target.file,
        targetSymbol: target.name,
        ...(target.parentClass ? { parentClass: target.parentClass } : {}),
        confidence: interfaceMethod ? 0.85 : resolved!.confidence,
        reason: reason === "factory-return" ? "factory-return" : interfaceMethod ? "method-on-receiver" : resolved!.reason,
      };
    }

    // Direct (non-member) calls: same-file, imported, implicit package, or unique workspace.
    const sameFile = entry.decls.find(
      (decl) => decl.name === call.callee && decl.parentClass === undefined
    );
    if (sameFile) {
      return {
        ...base,
        targetFile: sameFile.file,
        targetSymbol: sameFile.name,
        confidence: 0.9,
        reason: isTypeKind(sameFile.kind) ? "constructor" : "same-file",
      };
    }
    const imported = this.resolveImportedSymbol(callFile, call.callee);
    if (imported) {
      return {
        ...base,
        targetFile: imported.decl.file,
        targetSymbol: imported.decl.name,
        confidence: 0.95,
        reason: imported.via === "barrel" ? "barrel-reexport" : "imported-symbol",
      };
    }
    const implicit = this.implicitPackageDeclarations(callFile, call.callee);
    if (implicit.length === 1) {
      return {
        ...base,
        targetFile: implicit[0]!.file,
        targetSymbol: implicit[0]!.name,
        confidence: 0.8,
        reason: "implicit-package",
      };
    }
    if (implicit.length > 1) return { ...base, reason: "ambiguous" };
    const family = sourceLanguageFamily(callFile);
    const globalCandidates = (this.declsByName.get(call.callee) ?? []).filter(
      (decl) =>
        decl.parentClass === undefined &&
        sourceLanguageFamily(decl.file) === family &&
        (decl.kind === "function" || isTypeKind(decl.kind))
    );
    if (globalCandidates.length === 1) {
      const candidate = globalCandidates[0]!;
      return {
        ...base,
        targetFile: candidate.file,
        targetSymbol: candidate.name,
        confidence: 0.6,
        reason: isTypeKind(candidate.kind) ? "constructor" : "unique-workspace",
      };
    }
    return globalCandidates.length > 1 ? { ...base, reason: "ambiguous" } : base;
  }

  invalidate(file?: string): void {
    if (file) {
      this.removeEntry(file.replace(/\\/g, "/"));
      return;
    }
    this.entries.clear();
    this.declsByName.clear();
    this.moduleGraph.clear();
    this.fileStates.clear();
    this.namespaceToFiles.clear();
    this.hierarchyCache = null;
    this.aliasConfigCache = undefined;
    this.ensureFresh();
  }

  rebuild(): void {
    this.entries.clear();
    this.declsByName.clear();
    this.moduleGraph.clear();
    this.fileStates.clear();
    this.namespaceToFiles.clear();
    this.hierarchyCache = null;
    this.aliasConfigCache = undefined;
    this.buildTimeMs = 0;
    this.ensureFresh();
  }

  stats(): SemanticIndexStats {
    this.ensureFresh();
    let declarations = 0;
    for (const list of this.declsByName.values()) declarations += list.length;
    return {
      files: this.entries.size,
      modules: this.moduleGraph.size,
      declarations,
      buildTimeMs: this.buildTimeMs,
      queries: this.queries,
    };
  }
}

const indexByRoot = new Map<string, SemanticIndexImpl>();

/** Returns the cached semantic index for a workspace root (builds it on first use). */
export function getSemanticIndex(rootDir: string): SemanticIndex {
  const key = resolve(rootDir);
  let index = indexByRoot.get(key);
  if (!index) {
    index = new SemanticIndexImpl(key);
    indexByRoot.set(key, index);
  }
  return index;
}

/** Drops the cached semantic index for one root (or all roots) — used by tests. */
export function clearSemanticIndexCache(rootDir?: string): void {
  if (rootDir === undefined) {
    indexByRoot.clear();
    return;
  }
  indexByRoot.delete(resolve(rootDir));
}

/** Exposed for diagnostics/tests: resolve a type expression to a base receiver type. */
export function semanticBaseType(rawType: string): string | undefined {
  return unwrapTypeExpression(rawType);
}
