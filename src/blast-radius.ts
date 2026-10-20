/**
 * GraphFlow 3.3 — Pillar 2A: Blast-Radius Call-Site Micro-Snippets (`blast-radius.ts`)
 *
 * Uses a two-stage pipeline for <50ms workspace-wide call-site discovery across
 * TypeScript/JS, Python, Go, Rust, C/C++, and C#:
 *   Stage 1 (Fast Word-Boundary Pre-filter): Checks if `raw.content` contains
 *           `symbolName` as a whole identifier — `ID_Continue` boundaries, not `\b`,
 *           so `$symbolName` and non-ASCII identifiers are not false positives.
 *   Stage 2 (AST Verification): Parses only the candidate files that pass Stage 1
 *           and extracts exact call sites + 3-line numbered micro-snippets.
 *
 * Semantics:
 *   - Language-scoped: a Rust `cancel` never matches a C++ `cancel` (and vice versa).
 *   - Receiver-aware for methods: `service.cancelOrder(...)`, `this.cancelOrder(...)`,
 *     `OrderService.cancelOrder(...)`, `Engine::cancel(...)` are found through the
 *     imported parent class, not just through a direct import of the method name.
 *   - Receiver-TYPE-aware for methods: a lightweight per-file inference
 *     (`inferReceiverTypeIndex` in ast-engine) maps locals/parameters/fields to declared
 *     types, so `b.cancel()` is NOT counted for `A.cancel` when `b` is known to be a `B`.
 *     Unresolved receivers still fall back to the importer heuristic in other files
 *     (duck typing); in the declaring file, unknown receivers are ignored rather than
 *     attributed to every same-named method.
 *   - Inheritance-aware: `super`/`base` resolve to the parent class, and a subclass receiver
 *     dispatches to an inherited base method only when no class in between overrides it
 *     (`class B extends A` etc. parsed into a workspace parent map).
 *   - Generic/array/nullable annotations are unwrapped to their base type for matching.
 *   - Wildcard imports (`importedNames` containing "*", e.g. C++ `#include`) are never
 *     treated as importing a specific symbol.
 *   - Declaration headers (`bool Engine::cancel(int id);`) are never counted as calls.
 *   - Implicit package scope is narrow: Go = same package directory, C# = same
 *     directory (namespace approximation), C/C++ = same directory or header-stem match.
 *
 * A scoped symbol query (`A.cancel`, `A::cancel`) or the optional `targetParentClass`
 * argument selects one same-named method declaration; otherwise the first declaration wins.
 */

import { basename, dirname } from "node:path";
import {
  createWorkspaceTypeHierarchy,
  inImplicitPackageScope,
  inferReceiverTypeIndex,
  resolveReceiverType,
  resolveRelativeImportPath,
  sourceLanguageFamily,
  splitQualifiedSymbolName,
  type AstCallSite,
  type AstImport,
  type FileAstAnalysis,
  type ReceiverTypeIndex,
  type SourceLanguageFamily,
  type WorkspaceTypeHierarchy,
} from "./ast-engine.js";
import { formatNumberedLines, type getWorkspaceAstIndex } from "./slicer.js";
import {
  getSemanticIndex,
  SEMANTIC_CONFIDENCE_MIN,
  type SemanticResolvedCall,
} from "./semantic-index.js";
import { identifierBoundaryRe } from "./identifier-regex.js";

export { createWorkspaceTypeHierarchy, inImplicitPackageScope, type WorkspaceTypeHierarchy };

export interface CallSiteSnippet {
  file: string;
  line: number;
  caller?: string;
  argsCount: number;
  snippet: string; // 3-line numbered snippet around the call
}

export interface ImporterSite {
  file: string;
  line: number;
  rawImport: string;
}

export interface SymbolBlastRadius {
  targetFile: string;
  symbolName: string;
  totalCallSites: number;
  callSites: CallSiteSnippet[];
  importers: ImporterSite[];
}

function stemOf(relPath: string): string {
  return basename(relPath).replace(/\.[^.]+$/, "").toLowerCase();
}

/**
 * A namespace/wildcard import can still expose a symbol through a module member
 * access (`import * as m from "./mod"; m.foo()` or `#include "engine.h"`).
 * It is never treated as a *specific symbol importer*, but it does make member
 * calls in that file visible when the import resolves to the target file (or,
 * for C/C++, to a header with the same stem).
 */
function isNamespaceImportOfTarget(
  imp: AstImport,
  importerFile: string,
  targetFile: string,
  family: SourceLanguageFamily,
  rootDir: string,
  fileSet: ReadonlySet<string>
): boolean {
  // TS `import * as ns from "./mod"` is recorded as `importedNames: ["ns"]`, so the
  // wildcard must also be detected from the raw import statement.
  const isWildcard =
    imp.importedNames.includes("*") || /\bimport\s+\*\s+as\b/.test(imp.raw);
  if (!isWildcard) return false;
  const resolved = resolveRelativeImportPath(rootDir, importerFile, imp.module, fileSet);
  if (resolved) {
    if (resolved === targetFile) return true;
    if (family === "c" && stemOf(resolved) === stemOf(targetFile)) return true;
  }
  if (family === "go") {
    // Go imports are package paths, not relative files: compare the package leaf.
    const tail = imp.module.split("/").filter(Boolean).pop();
    if (tail && tail === basename(dirname(targetFile))) return true;
  }
  return false;
}

/**
 * R3: `alias.symbol(...)` where `alias` is an imported module (`import flask`,
 * `import x as flask`, `from . import helpers as h`) must resolve to the module that
 * actually defines `symbol`. Unresolvable aliases stay uncounted (no guessing).
 */
interface ModuleAliasBinding {
  alias: string;
  module: string;
}

function moduleAliasBindings(imp: AstImport, family: SourceLanguageFamily): ModuleAliasBinding[] {
  const raw = imp.raw.trim();
  if (family === "python") {
    const fromMatch = raw.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+\(?([^)]+)\)?/);
    if (fromMatch) {
      const base = fromMatch[1]!;
      const bindings: ModuleAliasBinding[] = [];
      for (const part of fromMatch[2]!.split(",")) {
        const match = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
        if (!match) continue;
        bindings.push({
          alias: match[2] ?? match[1]!,
          module: base.endsWith(".") ? `${base}${match[1]}` : `${base}.${match[1]}`,
        });
      }
      return bindings;
    }
    const directMatch = raw.match(/^import\s+(.+)$/);
    if (!directMatch) return [];
    const bindings: ModuleAliasBinding[] = [];
    for (const part of directMatch[1]!.split(",")) {
      const match = part.trim().match(/^([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
      if (!match) continue;
      bindings.push({
        alias: match[2] ?? match[1]!.split(".").pop()!,
        module: match[1]!,
      });
    }
    return bindings;
  }
  if (family === "js") {
    const namespaceMatch = raw.match(
      /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/
    );
    if (namespaceMatch) {
      return [{ alias: namespaceMatch[1]!, module: namespaceMatch[2]! }];
    }
  }
  return [];
}

/** Python absolute imports are package paths; match their file/`__init__.py` suffix. */
function pythonModuleCandidates(moduleSpec: string, fileSet: ReadonlySet<string>): string[] {
  const clean = moduleSpec.replace(/^\.+/, "").replace(/\./g, "/");
  if (!clean) return [];
  const moduleFile = `${clean}.py`;
  const initFile = `${clean}/__init__.py`;
  return [...fileSet]
    .filter(
      (relPath) =>
        relPath === moduleFile ||
        relPath.endsWith(`/${moduleFile}`) ||
        relPath === initFile ||
        relPath.endsWith(`/${initFile}`)
    )
    .sort(
      (a, b) =>
        a.split("/").length - b.split("/").length ||
        a.length - b.length ||
        a.localeCompare(b)
    );
}

/**
 * True when `moduleFile` (a package `__init__.py` or a module) re-exports `symbolName`
 * from `targetFile` through an explicit import chain (one or more hops).
 */
function moduleReexportsSymbolFromTarget(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  moduleFile: string,
  symbolName: string,
  targetFile: string,
  fileSet: ReadonlySet<string>,
  depth: number,
  visited: Set<string>
): boolean {
  if (moduleFile === targetFile) return true;
  if (depth <= 0 || visited.has(moduleFile)) return false;
  visited.add(moduleFile);
  const fileData = index.getFileAnalysis(moduleFile);
  if (!fileData) return false;
  for (const imp of fileData.ast.imports) {
    if (!imp.importedNames.includes(symbolName) && !imp.importedNames.includes("*")) continue;
    const resolved = resolveRelativeImportPath(index.rootDir, moduleFile, imp.module, fileSet);
    if (!resolved) continue;
    if (resolved === targetFile) return true;
    if (moduleReexportsSymbolFromTarget(index, resolved, symbolName, targetFile, fileSet, depth - 1, visited)) {
      return true;
    }
  }
  return false;
}

function aliasModuleResolvesToTarget(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  fromFile: string,
  moduleSpec: string,
  symbolName: string,
  targetFile: string,
  family: SourceLanguageFamily,
  fileSet: ReadonlySet<string>
): boolean {
  const resolved = resolveRelativeImportPath(index.rootDir, fromFile, moduleSpec, fileSet);
  if (resolved) {
    if (resolved === targetFile) return true;
    if (
      moduleReexportsSymbolFromTarget(index, resolved, symbolName, targetFile, fileSet, 3, new Set<string>())
    ) {
      return true;
    }
  }
  if (family === "python") {
    for (const candidate of pythonModuleCandidates(moduleSpec, fileSet)) {
      if (candidate === targetFile) return true;
      if (
        moduleReexportsSymbolFromTarget(index, candidate, symbolName, targetFile, fileSet, 3, new Set<string>())
      ) {
        return true;
      }
    }
  }
  return false;
}

/** E6: constructors are not callable symbols, so `this.m()` needs the enclosing class by range. */
function findEnclosingTypeName(ast: FileAstAnalysis, line: number): string | undefined {
  let best: { name: string; span: number } | undefined;
  for (const sym of ast.symbols) {
    if (
      sym.kind !== "class" &&
      sym.kind !== "interface" &&
      sym.kind !== "struct" &&
      sym.kind !== "type" &&
      sym.kind !== "enum"
    ) {
      continue;
    }
    if (line < sym.line || line > sym.endLine) continue;
    const span = sym.endLine - sym.line;
    if (!best || span < best.span) best = { name: sym.name, span };
  }
  return best?.name;
}

export function computeBlastRadius(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  targetFile: string,
  symbolName: string,
  maxCallSites = 6,
  targetParentClass?: string
): SymbolBlastRadius {
  const callSites: CallSiteSnippet[] = [];
  const importers: ImporterSite[] = [];
  let totalCallSites = 0;

  // A scoped query (`A.cancel`) or an explicit parent-class argument selects one of
  // several same-named method declarations in the target file.
  const parsedQuery = splitQualifiedSymbolName(symbolName);
  const effectiveSymbolName = parsedQuery.member;
  const parentClassHint = targetParentClass ?? parsedQuery.container;

  const wordRe = identifierBoundaryRe(effectiveSymbolName);
  const targetFamily = sourceLanguageFamily(targetFile);
  const fileSet = index.getFileSet();
  const targetAst = index.getFileAnalysis(targetFile)?.ast;
  const targetSymbol =
    parentClassHint !== undefined
      ? targetAst?.symbols.find(
          (s) => s.name === effectiveSymbolName && s.parentClass === parentClassHint
        )
      : targetAst?.symbols.find((s) => s.name === effectiveSymbolName);
  // An explicit `Class.method` query that does not exist in the target file has no callers.
  if (parentClassHint !== undefined && !targetSymbol) {
    return { targetFile, symbolName, totalCallSites: 0, callSites: [], importers: [] };
  }
  // Method-level analysis is keyed off the declaration's `parentClass`.
  const parentClass = targetSymbol?.parentClass ?? parentClassHint;
  const isMethodTarget = Boolean(parentClass);
  // Inheritance-aware matching for method receivers (`B extends A` -> inherited A methods).
  const hierarchy = isMethodTarget ? createWorkspaceTypeHierarchy(index) : undefined;

  // Prefer semantic call-target resolution when it can prove an answer; unresolved calls fall
  // back to the per-file heuristics below (guards/scoping remain unchanged either way).
  let semanticIndexRef: ReturnType<typeof getSemanticIndex> | null | undefined;
  const getSemantic = (): ReturnType<typeof getSemanticIndex> | undefined => {
    if (semanticIndexRef !== undefined) return semanticIndexRef ?? undefined;
    try {
      semanticIndexRef = getSemanticIndex(index.rootDir);
    } catch {
      semanticIndexRef = null;
    }
    return semanticIndexRef ?? undefined;
  };
  const isResolvedCallToTarget = (relPath: string, call: AstCallSite): boolean | undefined => {
    const semantic = getSemantic();
    if (!semantic) return undefined;
    let resolved: SemanticResolvedCall;
    try {
      resolved = semantic.resolveCall(relPath, call);
    } catch {
      return undefined;
    }
    if (!resolved.targetFile || !resolved.targetSymbol) return undefined;
    // Weak global-unique guesses are not authoritative; they fall back to the heuristic
    // guards below (e.g. a same-named symbol in another directory must not leak across
    // package/include boundaries).
    if (resolved.confidence < SEMANTIC_CONFIDENCE_MIN) return undefined;
    return (
      resolved.targetFile === targetFile &&
      resolved.targetSymbol === effectiveSymbolName &&
      (!isMethodTarget || (resolved.parentClass ?? "") === parentClass)
    );
  };

  // Prioritize production files ahead of tests/ and benchmarks/
  const allFiles = [...index.getFiles()].sort((a, b) => {
    const aProd = a.startsWith("tests/") || a.startsWith("benchmarks/") ? 1 : 0;
    const bProd = b.startsWith("tests/") || b.startsWith("benchmarks/") ? 1 : 0;
    return aProd - bProd || a.localeCompare(b);
  });

  for (const relPath of allFiles) {
    // Tests/benchmarks are still scanned so `totalCallSites` is the real count; only
    // their snippets are withheld once the display quota is full (below).
    // Never match across language families (identifier names collide frequently).
    if (sourceLanguageFamily(relPath) !== targetFamily) continue;

    const raw = index.getRawFile(relPath);
    if (!raw || !wordRe.test(raw.content)) continue;

    const fileData = index.getFileAnalysis(relPath);
    if (!fileData) continue;

    const isSameFile = relPath === targetFile;
    const samePackageScope = !isSameFile && inImplicitPackageScope(targetFile, relPath, targetFamily);

    // Explicit symbol/class imports only — a wildcard import imports nothing specific.
    const matchingImport = fileData.ast.imports.find((imp) =>
      imp.importedNames.includes(effectiveSymbolName)
    );
    const classImport = parentClass
      ? fileData.ast.imports.find((imp) => imp.importedNames.includes(parentClass))
      : undefined;
    const namespaceImport = fileData.ast.imports.find((imp) =>
      isNamespaceImportOfTarget(imp, relPath, targetFile, targetFamily, index.rootDir, fileSet)
    );

    // R3: module-alias receivers (`flask.url_for`, `h.foo` after `from . import helpers as h`).
    // Only aliases whose module actually defines/re-exports the target symbol are accepted.
    let moduleAliasReceivers: Set<string> | undefined;
    const getModuleAliasReceivers = (): Set<string> => {
      if (moduleAliasReceivers) return moduleAliasReceivers;
      const aliases = new Set<string>();
      if (!isMethodTarget) {
        for (const imp of fileData.ast.imports) {
          for (const binding of moduleAliasBindings(imp, targetFamily)) {
            if (
              aliasModuleResolvesToTarget(
                index,
                relPath,
                binding.module,
                effectiveSymbolName,
                targetFile,
                targetFamily,
                fileSet
              )
            ) {
              aliases.add(binding.alias);
            }
          }
        }
      }
      moduleAliasReceivers = aliases;
      return aliases;
    };

    // R3 (Python): `current_app.url_for(...)` binds an imported proxy name, not a module
    // alias. Accept it only when that import lives in the target's own package.
    let pythonProxyReceivers: Set<string> | undefined;
    const getPythonProxyReceivers = (): Set<string> => {
      if (pythonProxyReceivers) return pythonProxyReceivers;
      const receivers = new Set<string>();
      if (targetFamily === "python" && !isMethodTarget) {
        const targetDir = dirname(targetFile);
        for (const imp of fileData.ast.imports) {
          const resolved =
            resolveRelativeImportPath(index.rootDir, relPath, imp.module, fileSet) ??
            pythonModuleCandidates(imp.module, fileSet)[0];
          if (!resolved || dirname(resolved) !== targetDir) continue;
          for (const name of imp.importedNames) {
            if (name !== "*") receivers.add(name);
          }
        }
      }
      pythonProxyReceivers = receivers;
      return receivers;
    };

    // Receiver-type inference is only needed for receiver-aware method matching.
    let receiverIndex: ReceiverTypeIndex | undefined;
    const getReceiverIndex = (): ReceiverTypeIndex => {
      if (!receiverIndex) {
        receiverIndex = inferReceiverTypeIndex(relPath, fileData.content, fileData.ast);
      }
      return receiverIndex;
    };

    if (!isSameFile) {
      const importerImport = matchingImport ?? classImport;
      if (importerImport) {
        importers.push({
          file: relPath,
          line: importerImport.line,
          rawImport: importerImport.raw,
        });
      }
    }

    // For a method, resolve the receiver's inferred static type when possible:
    //   known & mismatched -> never a caller of this symbol; known & matching -> caller;
    //   unknown -> declaring file: ignore (fixes A/B same-name false positives),
    //              other file: existing importer heuristic (duck-typed receivers).
    const acceptsCall = (call: AstCallSite): boolean => {
      // A proven semantic target is authoritative (match or mismatch); only unresolved calls
      // fall through to the heuristic rules below.
      const semanticVerdict = isResolvedCallToTarget(relPath, call);
      if (semanticVerdict !== undefined) return semanticVerdict;
      if (!isMethodTarget) {
        if (isSameFile || Boolean(matchingImport) || Boolean(namespaceImport) || samePackageScope) {
          return true;
        }
        if (call.member && call.receiver) {
          if (getModuleAliasReceivers().has(call.receiver)) return true;
          if (getPythonProxyReceivers().has(call.receiver)) return true;
        }
        return false;
      }
      if (call.member) {
        let receiverType = resolveReceiverType(call, fileData.ast, getReceiverIndex());
        // E6: a constructor is not an AstSymbol, so `this.merge()` inside it has no
        // enclosing callable. Fall back to the enclosing class by line range.
        if (
          receiverType === undefined &&
          (call.receiver === "this" ||
            call.receiver === "self" ||
            call.receiver === "cls" ||
            call.receiver === "Self")
        ) {
          receiverType = findEnclosingTypeName(fileData.ast, call.line);
        }
        if (receiverType !== undefined) {
          // Inheritance-aware: a subclass receiver may dispatch to an inherited base method
          // only when no intermediate class overrides it; `super`/`base` resolve to the parent.
          return hierarchy
            ? hierarchy.isCompatibleReceiver(receiverType, parentClass!, effectiveSymbolName)
            : receiverType === parentClass;
        }
        if (
          call.receiver === "this" ||
          call.receiver === "self" ||
          call.receiver === "cls" ||
          call.receiver === "Self" ||
          call.receiver === "super" ||
          call.receiver === "base"
        ) {
          return false;
        }
        if (isSameFile) return false;
        return (
          Boolean(classImport) ||
          Boolean(matchingImport) ||
          Boolean(namespaceImport) ||
          samePackageScope
        );
      }
      // Direct (non-member) calls keep the previous behaviour.
      return isSameFile || Boolean(matchingImport) || Boolean(namespaceImport) || samePackageScope;
    };

    const fileCalls = fileData.ast.calls.filter(
      (c) => c.callee === effectiveSymbolName && !c.isDeclaration && acceptsCall(c)
    );
    if (fileCalls.length > 0) {
      const lines = fileData.content.split(/\r?\n/);
      for (const call of fileCalls) {
        totalCallSites += 1;
        if (callSites.length < maxCallSites) {
          const startL = Math.max(1, call.line - 1);
          const endL = Math.min(lines.length, call.line + 1);
          callSites.push({
            file: relPath,
            line: call.line,
            ...(call.caller ? { caller: call.caller } : {}),
            argsCount: call.argsCount,
            snippet: formatNumberedLines(lines, startL, endL),
          });
        }
      }
    }
  }

  return {
    targetFile,
    symbolName,
    totalCallSites,
    callSites,
    importers: importers.slice(0, maxCallSites),
  };
}

export function formatBlastRadiusText(blast: SymbolBlastRadius): string {
  if (blast.totalCallSites === 0 && blast.importers.length === 0) {
    return `// [Blast Radius] 0 external callers/importers for ${blast.symbolName}`;
  }

  const lines: string[] = [];
  if (blast.totalCallSites > 0) {
    const shown = blast.callSites.length;
    const more = blast.totalCallSites > shown ? ` (showing ${shown}/${blast.totalCallSites})` : "";
    lines.push(`// [Blast Radius: ${blast.totalCallSites} call site(s)${more}]`);
    for (const site of blast.callSites) {
      const inFn = site.caller ? ` in ${site.caller}()` : "";
      lines.push(`// -> ${site.file}:${site.line}${inFn} [args=${site.argsCount}]`);
      lines.push(site.snippet);
    }
  } else if (blast.importers.length > 0) {
    lines.push(`// [Blast Radius: imported by ${blast.importers.length} file(s)]`);
    for (const imp of blast.importers) {
      lines.push(`// -> ${imp.file}:${imp.line}: ${imp.rawImport}`);
    }
  }

  return lines.join("\n");
}
