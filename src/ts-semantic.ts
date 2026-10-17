/**
 * GraphFlow 3.4.1 — Optional L1 TypeScript Compiler Semantic Provider (`src/ts-semantic.ts`)
 *
 * This module is the "L1" semantic tier: a *real* TypeScript type checker used to answer
 * three questions that the existing name/receiver heuristics in `ast-engine.ts` /
 * `blast-radius.ts` cannot answer with certainty:
 *   1. `resolveCallTarget(file, line, callee)` — which declaration does this call site
 *      actually invoke? (correct for same-name methods on unrelated classes, import
 *      aliases, barrels/re-exports, inheritance and overloads)
 *   2. `getReferences(file, line, character?)` — every checker-verified reference.
 *   3. `getTypeAt(file, line, character?)` — the checker-printed type of an expression.
 *
 * Design constraints (deliberate, mirrors `tree-sitter-engine.ts`):
 *   - `typescript` is **not** a runtime dependency, only a devDependency. It is lazily
 *     `require`d; when it is unavailable (production install without dev deps) every
 *     factory returns `undefined` and every query degrades to "unknown" instead of
 *     throwing. `isTypeScriptAvailable()` reports availability without creating anything.
 *   - Read-only: a `ts.LanguageService` is created over a disk-backed host. Nothing is
 *     written, no program-wide diagnostics are surfaced, and missing/unreadable files are
 *     treated as `undefined`, never as an exception.
 *   - Cached per `rootDir` and disposed after an idle period (unref'd timer, so a cached
 *     provider never keeps a process alive). File snapshots are versioned by
 *     `mtime + size`, so edits on disk are picked up without recreating the provider.
 *   - Only declarations the checker can actually resolve are returned; anything else is
 *     `undefined`/`[]` ("graceful unknown") and the caller falls back to its heuristics.
 *
 * Not a replacement for `blast-radius.ts`: this tier is optional and heavier. Callers
 * should try it only when the cheap heuristics are ambiguous.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type * as TypeScript from "typescript";

const requireFn = createRequire(__filename);

type TypeScriptModule = typeof import("typescript");

const DEFAULT_IDLE_DISPOSE_MS = 5 * 60 * 1000;
const MAX_REFERENCE_RESULTS = 500;
const MAX_DISCOVERED_FILES = 5000;
const MAX_DISCOVERY_DEPTH = 12;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".git",
  ".graphflow",
  ".graphflow-cache",
  ".next",
]);
// Words that are never a useful "first identifier on the line" fallback position.
const NON_TARGET_WORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "return",
  "export",
  "import",
  "from",
  "default",
  "new",
  "this",
  "super",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "await",
  "async",
  "yield",
  "extends",
  "implements",
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "declare",
  "abstract",
  "override",
  "get",
  "set",
  "void",
  "null",
  "undefined",
  "true",
  "false",
]);

// ── Public types (no `typescript` types leaked: dist stays consumable without it) ───

/** A checker-verified source location. `line` is 1-based, `character` is 0-based (LSP-style column). */
export interface TsSemanticLocation {
  /** Workspace-relative path with forward slashes when inside the root, else absolute. */
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  /** True for the declaration itself (vs. a reference/call site). */
  isDefinition: boolean;
}

/** Result of `resolveCallTarget`. */
export interface TsCallTargetResolution {
  /** Target declaration file (workspace-relative when inside the root). */
  file: string;
  /** Target symbol name; methods are class-qualified (`Class.method`). */
  symbol: string;
  /** `function` | `method` | `constructor` | `accessor` | `property` | `class` | ... */
  kind: string;
  /** 1.0 = resolved signature; 0.85 = symbol/alias fallback. */
  confidence: number;
  /** Human-readable provenance, e.g. `type-checker signature -> method A.cancel in src/a.ts`. */
  reason: string;
}

export interface TsSemanticProviderOptions {
  /** Workspace root that the compiler project is built for. */
  rootDir: string;
  /** Optional explicit tsconfig/jsconfig path (absolute or rootDir-relative). */
  tsconfigPath?: string;
  /** Idle time before the provider auto-disposes. 0 disables idle disposal. */
  idleDisposeMs?: number;
}

/** Optional L1 semantic provider backed by the real TypeScript checker. */
export interface TsSemanticProvider {
  readonly rootDir: string;
  readonly engine: "typescript";
  readonly disposed: boolean;
  /**
   * Resolve the declaration invoked by a call on `line` (1-based) whose callee text
   * matches `callee` (bare name `cancel`, qualified `service.cancel`, ...). Returns
   * `undefined` unless the checker actually resolves a declaration.
   */
  resolveCallTarget(file: string, line: number, callee: string): TsCallTargetResolution | undefined;
  /**
   * Checker-verified references for the symbol at `(line, character?)`. When `character`
   * is omitted a best-effort identifier position on that line is used. Returns `[]` on
   * any failure (missing file, no symbol, checker unavailable).
   */
  getReferences(file: string, line: number, character?: number): TsSemanticLocation[];
  /**
   * Checker-printed type of the expression at `(line, character?)` (`"A"`, `"string"`,
   * `"A | undefined"`, ...). Returns `undefined` when the checker has nothing.
   */
  getTypeAt(file: string, line: number, character?: number): string | undefined;
  /** Release the language service and remove the provider from the per-root cache. */
  dispose(): void;
}

// ── Lazy TypeScript loading ─────────────────────────────────────────────────────────

let cachedTypeScript: TypeScriptModule | null | undefined;

function loadTypeScript(): TypeScriptModule | null {
  if (cachedTypeScript !== undefined) return cachedTypeScript;
  try {
    const loaded = requireFn("typescript") as TypeScriptModule | undefined;
    cachedTypeScript =
      loaded && typeof loaded.createLanguageService === "function" && typeof loaded.sys === "object"
        ? loaded
        : null;
  } catch {
    cachedTypeScript = null;
  }
  return cachedTypeScript;
}

/** True when an optional `typescript` compiler package can be loaded at runtime. */
export function isTypeScriptAvailable(): boolean {
  return loadTypeScript() !== null;
}

/** Version of the resolved optional `typescript` package, or `undefined` when unavailable. */
export function getTypeScriptVersion(): string | undefined {
  const ts = loadTypeScript();
  return ts ? ts.version : undefined;
}

// ── Small path/file helpers ────────────────────────────────────────────────────────

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

function canonicalPath(input: string): string {
  const slashed = normalizeSlashes(input);
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

function isFile(input: string): boolean {
  try {
    return statSync(input).isFile();
  } catch {
    return false;
  }
}

function readTextFile(input: string): string | undefined {
  try {
    return readFileSync(input, "utf8");
  } catch {
    return undefined;
  }
}

/** Recursively collect TS/JS sources under `rootDir` (bounded depth + file count). */
function discoverSourceFiles(rootDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DISCOVERY_DEPTH || found.length >= MAX_DISCOVERED_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries
      .map((entry) => ({ name: String(entry.name), directory: entry.isDirectory(), file: entry.isFile() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      if (found.length >= MAX_DISCOVERED_FILES) return;
      const fullPath = join(dir, entry.name);
      if (entry.directory) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.file && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(normalizeSlashes(fullPath));
      }
    }
  };
  walk(rootDir, 0);
  return found;
}

function defaultCompilerOptions(ts: TypeScriptModule): TypeScript.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    strict: false,
  };
}

interface ResolvedProjectConfig {
  fileNames: string[];
  options: TypeScript.CompilerOptions;
}

/**
 * Load `tsconfig.json`/`jsconfig.json` (or an explicit path) through the TypeScript
 * config parser, so `baseUrl` + `paths` aliases and `include` globs behave exactly like
 * a normal project. Falls back to a default project + recursive source discovery when no
 * usable config exists; a malformed config falls back rather than throwing.
 */
function resolveProjectConfig(
  ts: TypeScriptModule,
  rootDir: string,
  explicitTsconfigPath: string | undefined
): ResolvedProjectConfig {
  const candidates = explicitTsconfigPath
    ? [resolve(rootDir, explicitTsconfigPath)]
    : [join(rootDir, "tsconfig.json"), join(rootDir, "jsconfig.json")];
  for (const configPath of candidates) {
    if (!isFile(configPath)) continue;
    try {
      const read = ts.readConfigFile(configPath, (fileName) => readTextFile(fileName));
      if (read.error) continue;
      const parsed = ts.parseJsonConfigFileContent(
        read.config ?? {},
        ts.sys,
        dirname(configPath),
        undefined,
        configPath
      );
      const fileNames = parsed.fileNames.map((fileName) => normalizeSlashes(fileName));
      if (fileNames.length === 0) continue;
      return { fileNames, options: { ...parsed.options, noEmit: true, skipLibCheck: true } };
    } catch {
      // Malformed config / parser failure: keep looking, then fall back to defaults.
    }
  }
  return { fileNames: discoverSourceFiles(rootDir), options: defaultCompilerOptions(ts) };
}

// ── AST helpers (all take the lazily-loaded module) ────────────────────────────────

function declarationName(ts: TypeScriptModule, node: TypeScript.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const name = (node as { name?: TypeScript.Node }).name;
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return undefined;
}

function declarationKind(ts: TypeScriptModule, node: TypeScript.Node): string {
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return "accessor";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return "function";
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableDeclaration(node)) return "variable";
  return "unknown";
}

/** Name of the nearest enclosing class/interface declaration (for `Class.method` symbols). */
function enclosingClassName(ts: TypeScriptModule, node: TypeScript.Node): string | undefined {
  let current: TypeScript.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isClassDeclaration(current) ||
      ts.isClassExpression(current) ||
      ts.isInterfaceDeclaration(current)
    ) {
      const name = current.name;
      if (name) return name.text;
    }
    if (ts.isSourceFile(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function normalizeCalleeText(input: string): string {
  return input.replace(/\s+/g, "");
}

function callTargetName(ts: TypeScriptModule, expression: TypeScript.Expression, sourceFile: TypeScript.SourceFile): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const arg = expression.argumentExpression;
    if (arg && (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg))) return arg.text;
  }
  return normalizeCalleeText(expression.getText(sourceFile));
}

/**
 * Find the call expression on `line` (1-based) whose callee best matches `callee`.
 * Supported match forms: bare name (`cancel`), qualified (`service.cancel`, `a.b.cancel`),
 * and `this.cancel`. Exact matches win over suffix matches, which win over bare-name matches.
 */
function findCallOnLine(
  ts: TypeScriptModule,
  sourceFile: TypeScript.SourceFile,
  line: number,
  callee: string
): TypeScript.CallExpression | undefined {
  if (!Number.isInteger(line) || line < 1) return undefined;
  const wanted = normalizeCalleeText(callee);
  let best: TypeScript.CallExpression | undefined;
  let bestScore = -1;
  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node)) {
      let lineOfCall: number;
      try {
        lineOfCall = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      } catch {
        lineOfCall = -1;
      }
      if (lineOfCall === line) {
        const expression = node.expression;
        const full = normalizeCalleeText(expression.getText(sourceFile));
        let score = -1;
        if (wanted.length === 0) {
          score = 0;
        } else if (full === wanted) {
          score = 3;
        } else if (full.endsWith("." + wanted)) {
          score = 2;
        } else if (ts.isPropertyAccessExpression(expression) && expression.name.text === wanted) {
          score = 1;
        } else if (ts.isElementAccessExpression(expression)) {
          const arg = expression.argumentExpression;
          if (
            arg &&
            (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) &&
            arg.text === wanted
          ) {
            score = 1;
          }
        }
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bestScore >= 0 ? best : undefined;
}

/** Deepest node whose half-open span contains `position`. */
function findNodeAtPosition(
  ts: TypeScriptModule,
  sourceFile: TypeScript.SourceFile,
  position: number
): TypeScript.Node | undefined {
  let best: TypeScript.Node | undefined = sourceFile;
  const visit = (node: TypeScript.Node): void => {
    let start: number;
    try {
      start = node.getStart(sourceFile);
    } catch {
      return;
    }
    const end = node.getEnd();
    if (position < start || position >= end) return;
    if (node !== sourceFile) best = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return best;
}

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Best-effort position of a meaningful identifier on `line` (1-based), used when callers
 * do not pass an explicit `character`. Prefers a declaration name on that line, then the
 * first non-keyword identifier.
 */
function findIdentifierPosition(
  ts: TypeScriptModule,
  sourceFile: TypeScript.SourceFile,
  line: number
): number | undefined {
  const lineStarts = sourceFile.getLineStarts();
  const lineStart = lineStarts[line - 1];
  if (lineStart === undefined) return undefined;
  const lineEnd = line < lineStarts.length ? lineStarts[line] ?? sourceFile.text.length : sourceFile.text.length;

  // 1) AST declaration names on this exact line (variable/parameter/property/binding).
  let declared: number | undefined;
  const visit = (node: TypeScript.Node): void => {
    if (declared !== undefined) return;
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isBindingElement(node)
    ) {
      const name = node.name;
      if (name && name.getStart(sourceFile) >= lineStart && name.getStart(sourceFile) < lineEnd) {
        declared = name.getStart(sourceFile);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (declared !== undefined) return declared;

  // 2) First non-keyword identifier token.
  const lineText = sourceFile.text.slice(lineStart, lineEnd);
  IDENTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_RE.exec(lineText)) !== null) {
    const word = match[0];
    if (NON_TARGET_WORDS.has(word)) continue;
    return lineStart + match.index;
  }
  return undefined;
}

interface LocatedPosition {
  sourceFile: TypeScript.SourceFile;
  position: number;
}

// ── Provider implementation ────────────────────────────────────────────────────────

class TypeScriptSemanticProvider implements TsSemanticProvider {
  readonly rootDir: string;
  readonly engine = "typescript" as const;

  private readonly ts: TypeScriptModule;
  private readonly service: TypeScript.LanguageService;
  private readonly compilerOptions: TypeScript.CompilerOptions;
  private readonly idleDisposeMs: number;
  private readonly onDispose: () => void;
  private readonly snapshotCache = new Map<string, { version: string; snapshot: TypeScript.IScriptSnapshot }>();
  private idleTimer: NodeJS.Timeout | undefined;
  private disposedFlag = false;

  constructor(
    ts: TypeScriptModule,
    rootDir: string,
    options: TsSemanticProviderOptions,
    onDispose: () => void
  ) {
    this.ts = ts;
    this.rootDir = rootDir;
    this.idleDisposeMs = options.idleDisposeMs ?? DEFAULT_IDLE_DISPOSE_MS;
    this.onDispose = onDispose;

    const project = resolveProjectConfig(ts, rootDir, options.tsconfigPath);
    this.compilerOptions = project.options;

    const host: TypeScript.LanguageServiceHost = {
      getScriptFileNames: () => project.fileNames,
      getScriptVersion: (fileName) => this.scriptVersion(fileName),
      getScriptSnapshot: (fileName) => this.scriptSnapshot(fileName),
      getCurrentDirectory: () => this.rootDir,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
      fileExists: (fileName) => isFile(fileName),
      readFile: (fileName) => readTextFile(fileName),
      readDirectory: (path, extensions, exclude, include, depth) =>
        ts.sys.readDirectory(path, extensions, exclude, include, depth),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.service = ts.createLanguageService(
      host,
      ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, rootDir)
    );
    this.touch();
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  resolveCallTarget(
    file: string,
    line: number,
    callee: string
  ): TsCallTargetResolution | undefined {
    if (this.disposedFlag) return undefined;
    try {
      this.touch();
      const sourceFile = this.findSourceFile(file);
      const checker = this.checker();
      if (!sourceFile || !checker) return undefined;
      const call = findCallOnLine(this.ts, sourceFile, line, callee);
      if (!call) return undefined;

      const signature = checker.getResolvedSignature(call);
      const signatureDeclaration = signature?.getDeclaration();
      let targetNode: TypeScript.Node | undefined = signatureDeclaration;
      let viaSignature = true;
      let viaAlias = false;

      if (!targetNode) {
        viaSignature = false;
        let symbol = checker.getSymbolAtLocation(call.expression);
        if (symbol && (symbol.flags & this.ts.SymbolFlags.Alias) !== 0) {
          viaAlias = true;
          try {
            symbol = checker.getAliasedSymbol(symbol);
          } catch {
            symbol = undefined;
          }
        }
        targetNode = symbol?.declarations?.find((declaration) => !!declaration.getSourceFile());
      }
      if (!targetNode) return undefined;

      const targetSourceFile = targetNode.getSourceFile();
      const targetFile = this.toWorkspacePath(targetSourceFile.fileName);
      const kind = declarationKind(this.ts, targetNode);
      const name = declarationName(this.ts, targetNode) ?? callTargetName(this.ts, call.expression, sourceFile);
      const container = enclosingClassName(this.ts, targetNode);
      const symbolName =
        container && (kind === "method" || kind === "constructor" || kind === "accessor" || kind === "property")
          ? `${container}.${name}`
          : name;
      const reason = viaSignature
        ? `type-checker signature -> ${kind} ${symbolName} in ${targetFile}`
        : `type-checker symbol${viaAlias ? " (alias-followed)" : ""} -> ${kind} ${symbolName} in ${targetFile}`;
      return {
        file: targetFile,
        symbol: symbolName,
        kind,
        confidence: viaSignature ? 1 : 0.85,
        reason,
      };
    } catch {
      return undefined;
    }
  }

  getReferences(file: string, line: number, character?: number): TsSemanticLocation[] {
    if (this.disposedFlag) return [];
    try {
      this.touch();
      const located = this.locate(file, line, character);
      if (!located) return [];
      const referenced = this.service.findReferences(located.sourceFile.fileName, located.position);
      if (!referenced || referenced.length === 0) return [];

      const results: TsSemanticLocation[] = [];
      const seen = new Set<string>();
      const push = (
        fileName: string,
        span: TypeScript.TextSpan,
        isDefinition: boolean
      ): void => {
        const location = this.locationFromSpan(fileName, span, isDefinition);
        if (!location) return;
        const key = `${location.file}:${location.line}:${location.character}:${location.isDefinition ? 1 : 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push(location);
      };
      for (const group of referenced) {
        push(group.definition.fileName, group.definition.textSpan, true);
        for (const entry of group.references) {
          push(entry.fileName, entry.textSpan, entry.isDefinition === true);
        }
      }
      results.sort((left, right) => {
        if (left.file !== right.file) return left.file < right.file ? -1 : 1;
        if (left.line !== right.line) return left.line - right.line;
        return left.character - right.character;
      });
      return results.slice(0, MAX_REFERENCE_RESULTS);
    } catch {
      return [];
    }
  }

  getTypeAt(file: string, line: number, character?: number): string | undefined {
    if (this.disposedFlag) return undefined;
    try {
      this.touch();
      const located = this.locate(file, line, character);
      if (!located) return undefined;
      const checker = this.checker();
      if (!checker) return undefined;
      const node = findNodeAtPosition(this.ts, located.sourceFile, located.position);
      if (!node) return undefined;
      const type = checker.getTypeAtLocation(node);
      if (!type) return undefined;
      const flags =
        this.ts.TypeFormatFlags.NoTruncation |
        this.ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
      const text = checker.typeToString(type, node, flags).replace(/\s+/g, " ").trim();
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.snapshotCache.clear();
    try {
      this.service.dispose();
    } catch {
      // Ignore: disposing an already-broken service must stay side-effect free.
    }
    this.onDispose();
  }

  // ── internals ───────────────────────────────────────────────────────────────────

  private touch(): void {
    if (this.disposedFlag || this.idleDisposeMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), this.idleDisposeMs);
    // Never keep a host process alive just because a semantic provider is cached.
    this.idleTimer.unref();
  }

  private program(): TypeScript.Program | undefined {
    try {
      return this.service.getProgram();
    } catch {
      return undefined;
    }
  }

  private checker(): TypeScript.TypeChecker | undefined {
    const program = this.program();
    if (!program) return undefined;
    try {
      return program.getTypeChecker();
    } catch {
      return undefined;
    }
  }

  private findSourceFile(file: string): TypeScript.SourceFile | undefined {
    const program = this.program();
    if (!program) return undefined;
    let absolute: string;
    try {
      absolute = resolve(isAbsolute(file) ? file : join(this.rootDir, file));
    } catch {
      return undefined;
    }
    const direct = program.getSourceFile(absolute);
    if (direct) return direct;
    const wanted = canonicalPath(absolute);
    return program.getSourceFiles().find((sourceFile) => canonicalPath(sourceFile.fileName) === wanted);
  }

  private locate(file: string, line: number, character?: number): LocatedPosition | undefined {
    const sourceFile = this.findSourceFile(file);
    if (!sourceFile) return undefined;
    if (!Number.isInteger(line) || line < 1) return undefined;
    const lineStarts = sourceFile.getLineStarts();
    if (line > lineStarts.length) return undefined;

    let position: number;
    if (character !== undefined) {
      if (!Number.isInteger(character) || character < 0) return undefined;
      const lineStart = lineStarts[line - 1];
      if (lineStart === undefined) return undefined;
      const lineEnd =
        line < lineStarts.length ? lineStarts[line] ?? sourceFile.text.length : sourceFile.text.length;
      position = Math.min(lineStart + character, lineEnd);
    } else {
      const found = findIdentifierPosition(this.ts, sourceFile, line);
      if (found === undefined) return undefined;
      position = found;
    }
    if (position < 0 || position > sourceFile.text.length) return undefined;
    return { sourceFile, position };
  }

  private locationFromSpan(
    fileName: string,
    span: TypeScript.TextSpan,
    isDefinition: boolean
  ): TsSemanticLocation | undefined {
    const program = this.program();
    if (!program) return undefined;
    const sourceFile = program.getSourceFile(fileName) ?? program.getSourceFile(normalizeSlashes(fileName));
    if (!sourceFile) return undefined;
    try {
      const start = sourceFile.getLineAndCharacterOfPosition(span.start);
      const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length);
      return {
        file: this.toWorkspacePath(sourceFile.fileName),
        line: start.line + 1,
        character: start.character,
        endLine: end.line + 1,
        endCharacter: end.character,
        isDefinition,
      };
    } catch {
      return undefined;
    }
  }

  private toWorkspacePath(fileName: string): string {
    const normalized = normalizeSlashes(fileName);
    let rel: string;
    try {
      rel = relative(this.rootDir, normalized);
    } catch {
      return normalized;
    }
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return normalizeSlashes(rel);
    return normalized;
  }

  private scriptVersion(fileName: string): string {
    try {
      const stats = statSync(fileName);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      return "0";
    }
  }

  private scriptSnapshot(fileName: string): TypeScript.IScriptSnapshot | undefined {
    const version = this.scriptVersion(fileName);
    const cached = this.snapshotCache.get(fileName);
    if (cached && cached.version === version) return cached.snapshot;
    if (version === "0") return undefined;
    const text = readTextFile(fileName);
    if (text === undefined) return undefined;
    const snapshot = this.ts.ScriptSnapshot.fromString(text);
    this.snapshotCache.set(fileName, { version, snapshot });
    return snapshot;
  }
}

// ── Per-root cache + idle disposal ────────────────────────────────────────────────

const providerCache = new Map<string, TsSemanticProvider | null>();

function cacheKey(rootDir: string): string {
  const normalized = canonicalPath(normalizeSlashes(rootDir));
  return normalized;
}

/**
 * Create a standalone provider (caller owns `dispose()`). Returns `undefined` when the
 * optional `typescript` package is unavailable, the root does not exist, or project
 * setup fails — never throws.
 */
export function createTsSemanticProvider(
  options: TsSemanticProviderOptions
): TsSemanticProvider | undefined {
  const ts = loadTypeScript();
  if (!ts || !options || typeof options.rootDir !== "string") return undefined;
  let rootDir: string;
  try {
    rootDir = resolve(options.rootDir);
  } catch {
    return undefined;
  }
  if (!existsSync(rootDir)) return undefined;
  try {
    return new TypeScriptSemanticProvider(ts, rootDir, options, () => {
      // Standalone providers manage their own lifecycle; nothing cached to evict.
    });
  } catch {
    return undefined;
  }
}

/**
 * Get the cached provider for `rootDir`, creating it on first use. The cached provider
 * auto-disposes after `idleDisposeMs` (default 5 minutes) and its idle timer is unref'd,
 * so caching never blocks process exit. Returns `undefined` when TypeScript semantics are
 * unavailable (callers must fall back to the cheap heuristics).
 */
export function getTsSemanticProvider(
  rootDir: string,
  options?: Omit<TsSemanticProviderOptions, "rootDir">
): TsSemanticProvider | undefined {
  if (typeof rootDir !== "string" || rootDir.length === 0) return undefined;
  let absoluteRoot: string;
  try {
    absoluteRoot = resolve(rootDir);
  } catch {
    return undefined;
  }
  const key = cacheKey(absoluteRoot);
  if (providerCache.has(key)) {
    // `null` is the cached "unavailable" sentinel and maps back to `undefined`.
    return providerCache.get(key) ?? undefined;
  }
  const ts = loadTypeScript();
  if (!ts) {
    providerCache.set(key, null);
    return undefined;
  }
  if (!existsSync(absoluteRoot)) {
    providerCache.set(key, null);
    return undefined;
  }
  let created: TsSemanticProvider | undefined;
  try {
    created = new TypeScriptSemanticProvider(
      ts,
      absoluteRoot,
      {
        rootDir: absoluteRoot,
        ...(options?.tsconfigPath !== undefined ? { tsconfigPath: options.tsconfigPath } : {}),
        ...(options?.idleDisposeMs !== undefined ? { idleDisposeMs: options.idleDisposeMs } : {}),
      },
      () => {
        providerCache.delete(key);
      }
    );
  } catch {
    created = undefined;
  }
  providerCache.set(key, created ?? null);
  return created;
}

/** Dispose (and evict) the cached provider for one root, if any. */
export function disposeTsSemanticProvider(rootDir: string): void {
  let absoluteRoot: string;
  try {
    absoluteRoot = resolve(rootDir);
  } catch {
    return;
  }
  const key = cacheKey(absoluteRoot);
  const provider = providerCache.get(key);
  if (provider) provider.dispose();
  providerCache.delete(key);
}

/** Dispose every cached provider. Useful for tests and long-lived MCP hosts. */
export function disposeAllTsSemanticProviders(): void {
  const providers = [...providerCache.values()];
  providerCache.clear();
  for (const provider of providers) {
    if (provider) provider.dispose();
  }
}
