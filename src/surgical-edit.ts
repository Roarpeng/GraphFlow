/**
 * GraphFlow 3.0 — Pillar 2B & Pillar 3: Surgical Symbol/Line Edit, Atomic Multi-File Patch,
 * Deterministic Cross-Repo Symbol Rename & Instant Static Guard (`surgical-edit.ts`)
 *
 * Capabilities:
 *   1. Single or Batch Atomic Edit (`edits` array): Automatically sorts multiple edits
 *      within the same file bottom-up (descending `startLine`) so line numbers NEVER
 *      drift! Validates every touched file's AST syntax BEFORE committing to disk —
 *      if any file has a syntax error, ALL files are rolled back atomically.
 *   2. Zero-LLM Cross-Repo Symbol Rename (`renameTo`): Deterministically renames a
 *      symbol at its declaration AND across all workspace files that import/call it,
 *      spending 0 LLM output tokens on repetitive find-and-replace. Receiver-type
 *      inference keeps same-named methods on other classes untouched: files whose
 *      `<oldName>` calls all resolve to another receiver type are skipped, mixed-receiver
 *      files are rejected as `ambiguous-symbol` instead of being blindly rewritten.
 *      Inheritance (`class B extends A`, `super`/`base`/`Base::method`) is resolved too, so
 *      inherited and base-class call sites are renamed without touching overrides.
 *   3. Instant Post-Edit Static Guard: Checks AST syntax, broken relative imports,
 *      removed exports still imported elsewhere, and caller parameter arity drift.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  analyzeSourceFile,
  inImplicitPackageScope,
  inferReceiverTypeIndex,
  resolveReceiverType,
  resolveRelativeImportPath,
  sourceLanguageFamily,
  stripLineCommentsAndStrings,
  type AstCallSite,
  type AstSymbol,
} from "./ast-engine.js";
import {
  escapeRegExp,
  ID_CONTINUE_CLASS,
  identifierBoundary,
  identifierBoundaryRe,
  isIdentifierName,
} from "./identifier-regex.js";
import { computeBlastRadius, createWorkspaceTypeHierarchy } from "./blast-radius.js";
import {
  getSemanticIndex,
  SEMANTIC_CONFIDENCE_MIN,
  type SemanticResolvedCall,
} from "./semantic-index.js";
import { markSessionFilesEdited } from "./circuit-breaker.js";
import {
  findMatchingSymbolsInAst,
  formatNumberedLines,
  getWorkspaceAstIndex,
  normalizeWorkspaceRelPath,
  resolveSafeWorkspaceRoot,
} from "./slicer.js";

export interface SingleEditSpec {
  file: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  oldCode?: string;
  newCode?: string;
  /** Deterministic cross-repo rename target (renames symbol definition + all importers/callers). */
  renameTo?: string;
}

export interface SurgicalEditInput extends SingleEditSpec {
  rootDir: string;
  /** Optional batch of edits applied atomically (bottom-up line-drift-free per file). */
  edits?: SingleEditSpec[];
  /** Roll back all edits if AST syntax errors are introduced (default true). */
  rejectOnSyntaxError?: boolean;
  /** Optional callback to check learned user co-edit habits and auto-verify rules. */
  habitHook?: (editedFiles: string[]) => { coEditHints: string[]; autoVerifySummary?: string };
}

export interface StaticGuardDiagnostic {
  severity: "error" | "warn";
  kind:
    | "syntax"
    | "broken-import"
    | "caller-arity-mismatch"
    | "removed-export-still-imported"
    | "removed-struct-field-still-referenced"
    | "co-edit-habit";
  location: string;
  message: string;
}

export interface SurgicalEditResult {
  ok: boolean;
  file: string;
  touchedFiles: string[];
  mode: "symbol" | "line-range" | "search-replace" | "batch" | "rename";
  replacedSpan: [number, number];
  newSpan: [number, number];
  diagnostics: StaticGuardDiagnostic[];
  text: string;
}

/** Masks `/* ... *\/` so a doc comment that names `OrderService.cancel` is not a live reference. */
function maskBlockComments(content: string): string {
  let out = "";
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1] ?? "";
    const prev = i > 0 ? content[i - 1]! : "";
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        i += 1;
        continue;
      }
      out += ch === "\n" || ch === "\r" ? ch : " ";
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate && ch === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      i += 1;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'" && prev !== "\\") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"' && prev !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`" && prev !== "\\") inTemplate = !inTemplate;
    out += ch;
  }
  return out;
}

/**
 * Rewrites a bare declaration token (`def refund`, `cancel(`) on the given lines.
 * Member access (`obj.refund`, `Type::refund`) is left for `replaceMemberAccessOnLines`.
 */
function replaceBareIdentifierOnLines(
  content: string,
  oldName: string,
  newName: string,
  lines: ReadonlySet<number>
): { updated: string; count: number } {
  if (lines.size === 0) return { updated: content, count: 0 };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const parts = content.split(/\r?\n/);
  const re = new RegExp(`(^|[^\\p{ID_Continue}$.])${escapeRegExp(oldName)}(?!${ID_CONTINUE_CLASS})`, "gu");
  let count = 0;
  const next = parts.map((line, index) => {
    if (!lines.has(index + 1)) return line;
    return line.replace(re, (_match, prefix: string) => {
      count += 1;
      return `${prefix}${newName}`;
    });
  });
  return { updated: next.join(eol), count };
}

/**
 * Rewrites member accesses (`obj.method`, `super().method`, `obj->method`, `Type::method`)
 * of `oldName` on the given 1-based lines. Bare declarations (`def method`, `method(`) stay.
 */
function replaceMemberAccessOnLines(
  content: string,
  oldName: string,
  newName: string,
  lines: ReadonlySet<number>
): { updated: string; count: number } {
  if (lines.size === 0) return { updated: content, count: 0 };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const parts = content.split(/\r?\n/);
  const re = new RegExp(
    `(\\(\\s*\\)\\s*\\.|->|::|\\.)(\\s*)${escapeRegExp(oldName)}(?!${ID_CONTINUE_CLASS})`,
    "gu"
  );
  let count = 0;
  const next = parts.map((line, index) => {
    if (!lines.has(index + 1)) return line;
    return line.replace(re, (_match, access: string, space: string) => {
      count += 1;
      return `${access}${space}${newName}`;
    });
  });
  return { updated: next.join(eol), count };
}

/**
 * Best-effort semantic index access for rename safety analysis. If the index cannot be built
 * (dependency/runtime problem) rename keeps using the existing heuristic guards.
 */
function tryGetSemanticIndex(rootDir: string): ReturnType<typeof getSemanticIndex> | undefined {
  try {
    return getSemanticIndex(rootDir);
  } catch {
    return undefined;
  }
}

/**
 * Post-rename safety net: re-analyzes the workspace (staged content included) and returns
 * every same-language file whose code still references `oldName` in a way rename did not
 * rewrite — a leftover import, call, type reference, or a member/property reference
 * (dynamic/duck-typed receivers, wildcard imports, macro-generated names...).
 * Files that declare their own unrelated symbol with the same name are ignored.
 */
function collectUnresolvedRenameReferences(
  rootDir: string,
  index: ReturnType<typeof getWorkspaceAstIndex>,
  declRelPath: string,
  oldName: string,
  parentClass: string | undefined,
  family: ReturnType<typeof sourceLanguageFamily>,
  stagedWrites: ReadonlyMap<string, { absPath: string; content: string; replacements: number }>
): string[] {
  const found = new Map<string, string>();
  const add = (relPath: string, line: number, reason: string) => {
    if (!found.has(relPath)) found.set(relPath, `${relPath}:${line} (${reason})`);
  };

  const wordRe = identifierBoundaryRe(oldName);
  const propertyRefRe = new RegExp(
    `([A-Za-z_$][\\w$]*)\\s*(?:\\.|->|::)\\s*${identifierBoundary(oldName)}(?!\\s*\\()`,
    "gu"
  );
  const isMethodRename = Boolean(parentClass);
  const hierarchy = isMethodRename ? createWorkspaceTypeHierarchy(index) : undefined;
  const isTargetReceiver = (resolved: string | undefined): boolean => {
    if (resolved === undefined) return true; // unknown receivers remain possible callers
    if (!hierarchy || !parentClass) return resolved === parentClass;
    return hierarchy.isCompatibleReceiver(resolved, parentClass, oldName);
  };
  const semantic = tryGetSemanticIndex(rootDir);
  /** true = resolves to the rename target, false = provably another symbol, undefined = unknown. */
  const semanticVerdict = (relPath: string, call: AstCallSite): boolean | undefined => {
    if (!semantic) return undefined;
    let resolved: SemanticResolvedCall;
    try {
      resolved = semantic.resolveCall(relPath, call);
    } catch {
      return undefined;
    }
    if (!resolved.targetFile || !resolved.targetSymbol) return undefined;
    if (resolved.confidence < SEMANTIC_CONFIDENCE_MIN) return undefined;
    return (
      resolved.targetFile === declRelPath &&
      resolved.targetSymbol === oldName &&
      (resolved.parentClass ?? "") === (parentClass ?? "")
    );
  };
  const commentPrefix = family === "python" ? "#" : "//";
  const stagedPaths = new Set(stagedWrites.keys());

  for (const relPath of index.getFiles()) {
    if (stagedPaths.has(relPath) || relPath === declRelPath) continue;
    if (sourceLanguageFamily(relPath) !== family) continue;
    const absPath = join(rootDir, relPath);
    if (!existsSync(absPath)) continue;
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    if (!wordRe.test(content)) continue;

    const ast = analyzeSourceFile(relPath, content);
    const importLines = new Set(ast.imports.map((imp) => imp.line));
    // A sibling declaration of the same name is unrelated; its own callers stay valid.
    if (ast.symbols.some((s) => s.name === oldName)) continue;

    let receiverIndex: ReturnType<typeof inferReceiverTypeIndex> | undefined;
    const getReceiverIndex = (): ReturnType<typeof inferReceiverTypeIndex> => {
      if (receiverIndex === undefined) {
        receiverIndex = inferReceiverTypeIndex(relPath, content, ast);
      }
      return receiverIndex;
    };

    const staleImport = ast.imports.find((imp) => imp.importedNames.includes(oldName));
    if (staleImport) {
      add(relPath, staleImport.line, "still imports the old symbol name");
      continue;
    }

    const staleCalls = ast.calls.filter((c) => c.callee === oldName && !c.isDeclaration);
    if (staleCalls.length > 0) {
      // Prefer the semantic index's resolved target when available; receiver-type inference
      // and conservative assumptions remain the fallback for unresolved calls.
      const possibleCalls = staleCalls.filter((call) => {
        const verdict = semanticVerdict(relPath, call);
        if (verdict !== undefined) return verdict;
        if (!isMethodRename) return true;
        if (!call.member) return true;
        return isTargetReceiver(resolveReceiverType(call, ast, getReceiverIndex()));
      });
      const firstPossible = possibleCalls[0];
      if (firstPossible) {
        add(
          relPath,
          firstPossible.line,
          isMethodRename ? "still calls the old method name" : "still calls the old symbol name"
        );
        continue;
      }
    }

    if (ast.symbols.some((s) => s.referencedTypes.includes(oldName))) {
      add(relPath, 1, "still references the old type name");
      continue;
    }

    if (isMethodRename) {
      const lines = maskBlockComments(content).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (importLines.has(i + 1)) continue;
        const code = stripLineCommentsAndStrings(lines[i] ?? "", commentPrefix);
        propertyRefRe.lastIndex = 0;
        let possibleRef = false;
        for (const propertyMatch of code.matchAll(propertyRefRe)) {
          const receiverName = propertyMatch[1];
          if (!receiverName) {
            possibleRef = true;
            break;
          }
          const syntheticCall: AstCallSite = {
            callee: oldName,
            line: i + 1,
            argsCount: 0,
            receiver: receiverName,
            member: true,
          };
          const verdict = semanticVerdict(relPath, syntheticCall);
          if (verdict !== undefined) {
            if (!verdict) continue;
            possibleRef = true;
            break;
          }
          const resolved = resolveReceiverType(
            syntheticCall,
            ast,
            getReceiverIndex()
          );
          // A property reference on another class's receiver is unrelated to this rename.
          if (isTargetReceiver(resolved)) {
            possibleRef = true;
            break;
          }
        }
        if (!possibleRef) continue;
        add(relPath, i + 1, "still references the old method name as a property");
        break;
      }
    }
  }

  return [...found.values()];
}

/**
 * Deterministic Zero-LLM Cross-Repo Symbol Rename:
 * Renames `symbol` -> `renameTo` in `file` and in every workspace file that imports or calls it.
 */
function executeCrossRepoRename(
  rootDir: string,
  declFile: string,
  oldName: string,
  newName: string
): SurgicalEditResult {
  const safeRoot = resolveSafeWorkspaceRoot(rootDir);
  const relDecl = normalizeWorkspaceRelPath(safeRoot, declFile);
  if (!relDecl) {
    return {
      ok: false,
      file: declFile,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [0, 0],
      newSpan: [0, 0],
      diagnostics: [],
      text: `ERR [path-outside-workspace] '${declFile}' is outside workspace root.`,
    };
  }
  if (!isIdentifierName(newName)) {
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [0, 0],
      newSpan: [0, 0],
      diagnostics: [],
      text: `ERR [invalid-identifier] '${newName}' is not a valid identifier.`,
    };
  }

  const index = getWorkspaceAstIndex(rootDir);
  const declData = index.getFileAnalysis(relDecl);
  if (!declData) {
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [0, 0],
      newSpan: [0, 0],
      diagnostics: [],
      text: `ERR [file-not-found] ${relDecl}`,
    };
  }

  // Class-qualified ids (`OrderService.cancel`, `RefundPolicy.refund`) resolve the same way
  // gf_read does. A bare name that matches two declarations in this file is still ambiguous.
  const requestedSymbol = oldName;
  const matchedSyms = findMatchingSymbolsInAst(declData.ast, requestedSymbol);
  if (matchedSyms.length === 0) {
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [0, 0],
      newSpan: [0, 0],
      diagnostics: [],
      text: `ERR [symbol-not-found] '${requestedSymbol}' in ${relDecl}`,
    };
  }
  if (matchedSyms.length > 1) {
    const sym0 = matchedSyms[0]!;
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [sym0.line, sym0.endLine],
      newSpan: [sym0.line, sym0.endLine],
      diagnostics: [],
      text:
        `REJECTED [ambiguous-symbol] '${requestedSymbol}' is declared ${matchedSyms.length} times in ${relDecl} ` +
        `(lines ${matchedSyms.map((s) => s.line).join(", ")}). Rename the declaration manually or ` +
        `use a scoped edit so sibling methods are not rewritten.`,
    };
  }
  const sym = matchedSyms[0]!;
  oldName = sym.name;
  // A qualified id picks one declaration, but a same-file sibling with the same bare
  // name (A.cancel next to B.cancel) still cannot be word-replaced safely.
  const sameFileSiblings = declData.ast.symbols.filter(
    (candidate) =>
      candidate !== sym &&
      candidate.name === sym.name &&
      (candidate.parentClass ?? "") !== (sym.parentClass ?? "")
  );
  if (sameFileSiblings.length > 0) {
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [sym.line, sym.endLine],
      newSpan: [sym.line, sym.endLine],
      diagnostics: [],
      text:
        `REJECTED [ambiguous-symbol] '${requestedSymbol}' is declared ${sameFileSiblings.length + 1} times in ${relDecl} ` +
        `(lines ${[sym, ...sameFileSiblings].map((s) => s.line).join(", ")}). Rename the declaration manually or ` +
        `use a scoped edit so sibling methods are not rewritten.`,
    };
  }

  // Collect all files to update: declaration file + importers + callers + type-referencing files.
  // For methods, computeBlastRadius resolves member call sites through the imported parent class.
  const blast = computeBlastRadius(index, relDecl, oldName, 100, sym.parentClass);
  const candidateFiles = new Set<string>([
    relDecl,
    ...blast.importers.map((i) => i.file),
    ...blast.callSites.map((c) => c.file),
  ]);
  const parentClass = sym.parentClass;
  const declLangFamily = sourceLanguageFamily(relDecl);
  const typeCheckRe = identifierBoundaryRe(oldName);
  for (const relPath of index.getFiles(true)) {
    if (candidateFiles.has(relPath)) continue;
    // Cross-language references are impossible: never stage another family's same-named code.
    if (sourceLanguageFamily(relPath) !== declLangFamily) continue;
    const raw = index.getRawFile(relPath);
    if (!raw || !typeCheckRe.test(raw.content)) continue;
    const fData = index.getFileAnalysis(relPath);
    if (!fData) continue;
    // Explicit imports only: a wildcard import does not import this specific symbol.
    if (
      fData.ast.symbols.some((s) => s.referencedTypes.includes(oldName)) ||
      fData.ast.imports.some((imp) => imp.importedNames.includes(oldName))
    ) {
      candidateFiles.add(relPath);
    }
  }

  // Split declarations (C/C++ header prototype + source definition, ...) are the *same*
  // symbol: include body-less prototypes/definitions in the same package/scope so renaming a
  // definition also fixes its header (and vice versa) instead of leaving a stale prototype.
  const declFamily = sourceLanguageFamily(relDecl);
  const isSameDeclarationCluster = (candidate: AstSymbol): boolean =>
    (candidate.parentClass ?? "") === (parentClass ?? "") &&
    (candidate.kind === "function" || candidate.kind === "method") &&
    candidate.paramsCount === sym.paramsCount;
  for (const relPath of index.getFiles(true)) {
    if (declFamily !== "c") break; // split prototype/definition declarations exist in C/C++
    if (candidateFiles.has(relPath)) continue;
    if (sourceLanguageFamily(relPath) !== declFamily) continue;
    const raw = index.getRawFile(relPath);
    if (!raw || !typeCheckRe.test(raw.content)) continue;
    if (
      dirname(relPath) !== dirname(relDecl) &&
      !inImplicitPackageScope(relDecl, relPath, declFamily)
    ) {
      continue;
    }
    const fData = index.getFileAnalysis(relPath);
    if (!fData) continue;
    if (fData.ast.symbols.some((s) => s.name === oldName && isSameDeclarationCluster(s))) {
      candidateFiles.add(relPath);
    }
  }

  // A candidate file may declare its own same-named symbol. An override in a subclass
  // (`class Vip extends OrderService { cancel() { super.cancel() } }`) is the same method
  // hierarchy: keep the override declaration and rewrite only the base call (`super.cancel`).
  // An unrelated sibling (another class that merely shares the name) is still rejected.
  const hierarchy = parentClass ? createWorkspaceTypeHierarchy(index) : undefined;
  const overrideFiles = new Set<string>();
  for (const relPath of candidateFiles) {
    if (relPath === relDecl) continue;
    const candidateAst = index.getFileAnalysis(relPath)?.ast;
    const conflicts = candidateAst?.symbols.filter((s) => s.name === oldName) ?? [];
    let sawOverride = false;
    for (const conflicting of conflicts) {
      // Prototype/definition pairs of the same declaration are updated together, not rejected.
      if (isSameDeclarationCluster(conflicting)) continue;
      const sub = conflicting.parentClass;
      if (hierarchy && parentClass && sub && hierarchy.isSubclassOf(sub, parentClass)) {
        sawOverride = true;
        continue;
      }
      return {
        ok: false,
        file: relDecl,
        touchedFiles: [],
        mode: "rename",
        replacedSpan: [sym.line, sym.endLine],
        newSpan: [sym.line, sym.endLine],
        diagnostics: [],
        text:
          `REJECTED [ambiguous-symbol] '${oldName}' is also declared in ${relPath}:${conflicting.line}; ` +
          `renaming '${relDecl}' would rewrite that unrelated symbol too. Rename it manually.`,
      };
    }
    if (sawOverride) overrideFiles.add(relPath);
  }

  // Receiver-type-aware staging for methods: a candidate file whose `<oldName>` calls all
  // resolve to a *different* inferred receiver type has no target call sites and must not be
  // rewritten (blind word replacement would rename that other class's method). A file that
  // mixes target and foreign receivers cannot be safely blind-replaced either -> reject.
  if (parentClass && hierarchy) {
    const semantic = tryGetSemanticIndex(rootDir);
    const isTargetReceiver = (resolved: string | undefined): boolean => {
      if (resolved === undefined) return true; // unknown -> keep (renamed by word replace)
      return hierarchy.isCompatibleReceiver(resolved, parentClass, oldName);
    };
    const semanticVerdictForCall = (relPath: string, call: AstCallSite): boolean | undefined => {
      if (!semantic) return undefined;
      let resolved: SemanticResolvedCall;
      try {
        resolved = semantic.resolveCall(relPath, call);
      } catch {
        return undefined;
      }
      if (!resolved.targetFile || !resolved.targetSymbol) return undefined;
      if (resolved.confidence < SEMANTIC_CONFIDENCE_MIN) return undefined;
      return (
        resolved.targetFile === relDecl &&
        resolved.targetSymbol === oldName &&
        (resolved.parentClass ?? "") === parentClass
      );
    };
    const receiverConflicts: string[] = [];
    for (const relPath of [...candidateFiles]) {
      if (relPath === relDecl) continue;
      const candidate = index.getFileAnalysis(relPath);
      if (!candidate) continue;
      const receiverIndex = inferReceiverTypeIndex(relPath, candidate.content, candidate.ast);
      const oldCalls = candidate.ast.calls.filter(
        (call) => call.callee === oldName && !call.isDeclaration
      );
      let targetRelated = 0;
      let foreignReceiver = 0;
      for (const call of oldCalls) {
        if (!call.member) {
          targetRelated += 1;
          continue;
        }
        const semanticVerdict = semanticVerdictForCall(relPath, call);
        if (semanticVerdict !== undefined) {
          if (semanticVerdict) targetRelated += 1;
          else foreignReceiver += 1;
          continue;
        }
        const resolved = resolveReceiverType(call, candidate.ast, receiverIndex);
        if (isTargetReceiver(resolved)) targetRelated += 1;
        else foreignReceiver += 1;
      }
      if (foreignReceiver > 0 && targetRelated === 0) {
        // Clearly another class's receiver: leave the file untouched.
        candidateFiles.delete(relPath);
      } else if (foreignReceiver > 0) {
        receiverConflicts.push(
          `${relPath} (<${oldName}> call(s) on another receiver type)`
        );
      }
    }
    // The declaring file itself may mix receiver types as well.
    const declReceiverIndex = inferReceiverTypeIndex(relDecl, declData.content, declData.ast);
    for (const call of declData.ast.calls) {
      if (call.callee !== oldName || call.isDeclaration || !call.member) continue;
      const semanticVerdict = semanticVerdictForCall(relDecl, call);
      if (semanticVerdict === false) {
        receiverConflicts.push(`${relDecl}:${call.line} (semantic target is another symbol)`);
        continue;
      }
      if (semanticVerdict === true) continue;
      const resolved = resolveReceiverType(call, declData.ast, declReceiverIndex);
      if (resolved !== undefined && !isTargetReceiver(resolved)) {
        receiverConflicts.push(`${relDecl}:${call.line} (receiver type ${resolved})`);
      }
    }
    if (receiverConflicts.length > 0) {
      return {
        ok: false,
        file: relDecl,
        touchedFiles: [],
        mode: "rename",
        replacedSpan: [sym.line, sym.endLine],
        newSpan: [sym.line, sym.endLine],
        diagnostics: [],
        text: [
          `REJECTED [ambiguous-symbol] Cannot safely rename '${oldName}' on ${parentClass}: ` +
            `mixed same-named calls resolve to other receiver types:`,
          ...receiverConflicts.map((item) => `  - ${item}`),
          "Rename the intended declaration manually so unrelated methods are not rewritten.",
        ].join("\n"),
      };
    }
  }

  const wordRe = identifierBoundaryRe(oldName, "g");
  const stagedWrites = new Map<string, { absPath: string; content: string; replacements: number }>();
  const diagnostics: StaticGuardDiagnostic[] = [];

  for (const relPath of candidateFiles) {
    const absPath = join(rootDir, relPath);
    if (!existsSync(absPath)) continue;
    const raw = readFileSync(absPath, "utf8");
    let count = 0;
    let updated: string;
    if (parentClass && hierarchy) {
      // Methods are not blind word-replaced: `from billing.refund` and prose must stay,
      // while `def refund` / `policy.refund(` / `super().refund(` update.
      const isOverride = overrideFiles.has(relPath);
      const fData = index.getFileAnalysis(relPath);
      const ast = fData?.ast ?? analyzeSourceFile(relPath, raw);
      const receiverIndex = inferReceiverTypeIndex(relPath, raw, ast);
      const semantic = tryGetSemanticIndex(rootDir);
      const semanticHitsTarget = (call: AstCallSite): boolean | undefined => {
        if (!semantic) return undefined;
        let resolved: SemanticResolvedCall;
        try {
          resolved = semantic.resolveCall(relPath, call);
        } catch {
          return undefined;
        }
        if (!resolved.targetFile || !resolved.targetSymbol) return undefined;
        if (resolved.confidence < SEMANTIC_CONFIDENCE_MIN) return undefined;
        return (
          resolved.targetFile === relDecl &&
          resolved.targetSymbol === oldName &&
          (resolved.parentClass ?? "") === parentClass
        );
      };
      const declLines = new Set<number>();
      if (!isOverride) {
        for (const candidate of ast.symbols) {
          if (candidate.name !== oldName) continue;
          if ((candidate.parentClass ?? "") !== parentClass) continue;
          declLines.add(candidate.line);
        }
      }
      const targetLines = new Set<number>();
      for (const call of ast.calls) {
        if (call.callee !== oldName || call.isDeclaration || !call.member) continue;
        // Alias imports (`OrderService as Svc`) and inherited receivers are proven here.
        // A same-named type in another language must not hide that proof.
        const verdict = semanticHitsTarget(call);
        if (verdict === true) {
          targetLines.add(call.line);
          continue;
        }
        if (verdict === false) continue;
        const resolved = resolveReceiverType(call, ast, receiverIndex);
        if (resolved === undefined) {
          const lineText = raw.split(/\r?\n/)[call.line - 1] ?? "";
          if (isOverride) {
            if (/\b(?:super|base)\b/.test(lineText)) targetLines.add(call.line);
          } else if (!/^\s*(?:from|import)\b/.test(lineText)) {
            // Unknown receiver in a file already staged as a target caller (duck typing).
            targetLines.add(call.line);
          }
          continue;
        }
        if (hierarchy.isCompatibleReceiver(resolved, parentClass, oldName)) {
          targetLines.add(call.line);
        }
      }
      if (isOverride && targetLines.size === 0) {
        const fallbackRe = new RegExp(
          `\\b(?:super\\s*(?:\\([^)]*\\))?\\s*\\.\\s*|base\\s*\\.\\s*)${escapeRegExp(oldName)}(?!${ID_CONTINUE_CLASS})`,
          "u"
        );
        raw.split(/\r?\n/).forEach((line, index) => {
          if (fallbackRe.test(line)) targetLines.add(index + 1);
        });
      }
      const members = replaceMemberAccessOnLines(raw, oldName, newName, targetLines);
      const declared = replaceBareIdentifierOnLines(members.updated, oldName, newName, declLines);
      updated = declared.updated;
      count = members.count + declared.count;
    } else {
      updated = raw.replace(wordRe, () => {
        count += 1;
        return newName;
      });
    }
    if (count === 0) continue;

    const afterAst = analyzeSourceFile(relPath, updated);
    for (const synErr of afterAst.syntaxErrors) {
      diagnostics.push({
        severity: "error",
        kind: "syntax",
        location: `${relPath}:${synErr.line}`,
        message: synErr.message,
      });
    }
    stagedWrites.set(relPath, { absPath, content: updated, replacements: count });
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [sym.line, sym.endLine],
      newSpan: [sym.line, sym.endLine],
      diagnostics,
      text: `REJECTED [rename-syntax-error] Rolled back rename ${oldName} -> ${newName}:\n` +
        diagnostics.map((d) => `  - ${d.location}: ${d.message}`).join("\n"),
    };
  }

  // Safety re-analysis on the staged (not-yet-written) workspace: if the old name still
  // survives as a call/import/reference in the same language family, the rename would
  // silently leave broken callers (duck-typed receivers, wildcard imports, macros...).
  // Nothing has been written yet, so "rolling back" is simply not committing the stage.
  const targetFamily = sourceLanguageFamily(relDecl);
  const unresolvedFiles = collectUnresolvedRenameReferences(
    rootDir,
    index,
    relDecl,
    oldName,
    parentClass,
    targetFamily,
    stagedWrites
  );

  if (unresolvedFiles.length > 0) {
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [sym.line, sym.endLine],
      newSpan: [sym.line, sym.endLine],
      diagnostics,
      text: [
        `REJECTED [rename-unresolved-callers] Rolled back rename ${oldName} -> ${newName}: ` +
          `the old name is still referenced at:`,
        ...unresolvedFiles.map((item) => `  - ${item}`),
        "Review these call sites (dynamic/unknown receiver types) and rename them manually, or retry after they are fixed.",
      ].join("\n"),
    };
  }

  let totalOccurrences = 0;
  const touchedFiles: string[] = [];
  for (const [relPath, item] of stagedWrites) {
    writeFileSync(item.absPath, item.content, "utf8");
    index.invalidateFile(relPath);
    touchedFiles.push(relPath);
    totalOccurrences += item.replacements;
  }
  markSessionFilesEdited(safeRoot, "main", touchedFiles);

  return {
    ok: true,
    file: relDecl,
    touchedFiles,
    mode: "rename",
    replacedSpan: [sym.line, sym.endLine],
    newSpan: [sym.line, sym.endLine],
    diagnostics,
    text: `OK [renamed '${oldName}' -> '${newName}'] ${totalOccurrences} occurrence(s) across ${touchedFiles.length} file(s): ${touchedFiles.join(", ")}`,
  };
}

export function executeSurgicalEdit(input: SurgicalEditInput): SurgicalEditResult {
  // Handle Deterministic Cross-Repo Symbol Rename (Pillar 3 + Pillar 2)
  if (input.symbol && input.renameTo && !input.newCode) {
    return executeCrossRepoRename(input.rootDir, input.file, input.symbol, input.renameTo);
  }

  const specs: SingleEditSpec[] =
    Array.isArray(input.edits) && input.edits.length > 0
      ? input.edits
      : [
          {
            file: input.file,
            ...(input.symbol ? { symbol: input.symbol } : {}),
            ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
            ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
            ...(input.oldCode !== undefined ? { oldCode: input.oldCode } : {}),
            ...(input.newCode !== undefined ? { newCode: input.newCode } : {}),
          },
        ];

  const safeRoot = resolveSafeWorkspaceRoot(input.rootDir);
  const index = getWorkspaceAstIndex(safeRoot);

  // Group edits by normalized file path so multiple edits to the same file
  // are resolved against the original AST and applied bottom-up (no line drift!)
  const byFile = new Map<string, SingleEditSpec[]>();
  for (const spec of specs) {
    const rawFile = spec.file || input.file || "";
    const rel = normalizeWorkspaceRelPath(safeRoot, rawFile);
    if (!rel) {
      return {
        ok: false,
        file: rawFile,
        touchedFiles: [],
        mode: specs.length > 1 ? "batch" : "symbol",
        replacedSpan: [0, 0],
        newSpan: [0, 0],
        diagnostics: [],
        text: `ERR [path-outside-workspace] '${rawFile}' resolves outside workspace root.`,
      };
    }
    const list = byFile.get(rel) ?? [];
    list.push({ ...spec, file: rel });
    byFile.set(rel, list);
  }

  interface ResolvedPatch {
    startLine: number;
    endLine: number;
    newLines: string[];
    mode: "symbol" | "line-range" | "search-replace";
  }

  const stagedFiles = new Map<
    string,
    {
      absPath: string;
      beforeAst: ReturnType<typeof analyzeSourceFile>;
      afterAst: ReturnType<typeof analyzeSourceFile>;
      updatedContent: string;
      firstReplacedSpan: [number, number];
      firstNewSpan: [number, number];
      mode: "symbol" | "line-range" | "search-replace";
    }
  >();
  const diagnostics: StaticGuardDiagnostic[] = [];

  for (const [relPath, fileSpecs] of byFile) {
    const absPath = join(safeRoot, relPath);
    if (!existsSync(absPath)) {
      return {
        ok: false,
        file: relPath,
        touchedFiles: [],
        mode: specs.length > 1 ? "batch" : "symbol",
        replacedSpan: [0, 0],
        newSpan: [0, 0],
        diagnostics: [],
        text: `ERR [file-not-found] ${relPath}`,
      };
    }

    const originalContent = readFileSync(absPath, "utf8");
    const fileEol = originalContent.includes("\r\n") ? "\r\n" : "\n";
    const originalLines = originalContent.split(/\r?\n/);
    const beforeAst = analyzeSourceFile(relPath, originalContent);

    const patches: ResolvedPatch[] = [];
    const normalizedContentLf = originalLines.join("\n");

    for (const spec of fileSpecs) {
      const replacement = spec.newCode ?? "";
      if (spec.symbol) {
        const matchedSyms = findMatchingSymbolsInAst(beforeAst, spec.symbol);
        if (matchedSyms.length === 0) {
          const available = beforeAst.symbols.map((s) => `${s.name}(L${s.line}-${s.endLine})`).join(", ");
          return {
            ok: false,
            file: relPath,
            touchedFiles: [],
            mode: "symbol",
            replacedSpan: [0, 0],
            newSpan: [0, 0],
            diagnostics: [],
            text: `ERR [symbol-not-found] '${spec.symbol}' in ${relPath}. Available: ${available || "none"}`,
          };
        }
        if (matchedSyms.length > 1) {
          const candidatesDesc = matchedSyms
            .map((m) => {
              const parent = beforeAst.symbols.find(
                (p) =>
                  p !== m &&
                  (p.kind === "class" || p.kind === "struct" || p.kind === "interface") &&
                  m.line >= p.line &&
                  m.endLine <= p.endLine
              );
              return parent
                ? `${parent.name}.${m.name}(L${m.line}-${m.endLine})`
                : `${m.name}(L${m.line}-${m.endLine})`;
            })
            .join(", ");
          return {
            ok: false,
            file: relPath,
            touchedFiles: [],
            mode: "symbol",
            replacedSpan: [0, 0],
            newSpan: [0, 0],
            diagnostics: [],
            text: `ERR [ambiguous-symbol] Multiple symbols named '${spec.symbol}' in ${relPath}: ${candidatesDesc}. Disambiguate with 'ClassName.${spec.symbol}' or startLine/endLine.`,
          };
        }
        const sym = matchedSyms[0]!;
        patches.push({
          startLine: sym.line,
          endLine: sym.endLine,
          newLines: replacement.split(/\r?\n/),
          mode: "symbol",
        });
      } else if (typeof spec.startLine === "number" && typeof spec.endLine === "number") {
        const s = Math.max(1, spec.startLine);
        const e = Math.min(originalLines.length, Math.max(s, spec.endLine));
        patches.push({
          startLine: s,
          endLine: e,
          newLines: replacement.split(/\r?\n/),
          mode: "line-range",
        });
      } else if (typeof spec.oldCode === "string" && spec.oldCode.length > 0) {
        const normalizedOldLf = spec.oldCode.split(/\r?\n/).join("\n");
        const idx = normalizedContentLf.indexOf(normalizedOldLf);
        let sLine = -1;
        let eLine = -1;
        if (idx !== -1) {
          const prefix = normalizedContentLf.slice(0, idx);
          sLine = prefix.split("\n").length;
          eLine = sLine + normalizedOldLf.split("\n").length - 1;
        } else {
          const oldTrimmed = normalizedOldLf.split("\n").map((l) => l.trim());
          if (oldTrimmed.length > 0 && oldTrimmed.some((l) => l.length > 0)) {
            for (let i = 0; i <= originalLines.length - oldTrimmed.length; i++) {
              let allMatch = true;
              for (let j = 0; j < oldTrimmed.length; j++) {
                if (originalLines[i + j]!.trim() !== oldTrimmed[j]) {
                  allMatch = false;
                  break;
                }
              }
              if (allMatch) {
                sLine = i + 1;
                eLine = i + oldTrimmed.length;
                break;
              }
            }
          }
        }
        if (sLine === -1 || eLine === -1) {
          return {
            ok: false,
            file: relPath,
            touchedFiles: [],
            mode: "search-replace",
            replacedSpan: [0, 0],
            newSpan: [0, 0],
            diagnostics: [],
            text: `ERR [oldCode-not-found] Exact match not found in ${relPath}. Call gf_read(targets=["${relPath}"]) to inspect current line numbers.`,
          };
        }
        patches.push({
          startLine: sLine,
          endLine: eLine,
          newLines: replacement.split(/\r?\n/),
          mode: "search-replace",
        });
      } else {
        return {
          ok: false,
          file: relPath,
          touchedFiles: [],
          mode: "symbol",
          replacedSpan: [0, 0],
          newSpan: [0, 0],
          diagnostics: [],
          text: `ERR [invalid-args] Provide 'symbol', ('startLine' + 'endLine'), 'oldCode', or 'renameTo'.`,
        };
      }
    }

    // Sort patches descending by startLine so earlier patches never shift line numbers of later ones!
    const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine);
    const workingLines = [...originalLines];
    for (const p of sortedPatches) {
      workingLines.splice(p.startLine - 1, p.endLine - p.startLine + 1, ...p.newLines);
    }

    const updatedContent = workingLines.join(fileEol);
    const afterAst = analyzeSourceFile(relPath, updatedContent);

    for (const synErr of afterAst.syntaxErrors) {
      diagnostics.push({
        severity: "error",
        kind: "syntax",
        location: `${relPath}:${synErr.line}${synErr.column !== undefined ? `:${synErr.column}` : ""}`,
        message: synErr.message,
      });
    }

    const firstPatch = patches[0]!;
    stagedFiles.set(relPath, {
      absPath,
      beforeAst,
      afterAst,
      updatedContent,
      firstReplacedSpan: [firstPatch.startLine, firstPatch.endLine],
      firstNewSpan: [
        firstPatch.startLine,
        firstPatch.startLine + firstPatch.newLines.length - 1,
      ],
      mode: firstPatch.mode,
    });
  }

  const primaryFile = Array.from(stagedFiles.keys())[0] ?? input.file;
  const primaryStaged = stagedFiles.get(primaryFile);

  // Atomic Rollback if ANY file has a syntax error
  if (diagnostics.some((d) => d.severity === "error") && input.rejectOnSyntaxError !== false) {
    const firstErr = diagnostics.find((d) => d.severity === "error")!;
    const errFile = firstErr.location.split(":")[0]!;
    const errLine = Number.parseInt(firstErr.location.split(":")[1] ?? "1", 10);
    const stagedErrFile = stagedFiles.get(errFile);
    const updatedLines = stagedErrFile ? stagedErrFile.updatedContent.split(/\r?\n/) : [];
    const contextSnippet =
      updatedLines.length > 0
        ? formatNumberedLines(
            updatedLines,
            Math.max(1, errLine - 2),
            Math.min(updatedLines.length, errLine + 2)
          )
        : "";

    return {
      ok: false,
      file: primaryFile,
      touchedFiles: [],
      mode: specs.length > 1 ? "batch" : (primaryStaged?.mode ?? "symbol"),
      replacedSpan: primaryStaged?.firstReplacedSpan ?? [0, 0],
      newSpan: primaryStaged?.firstNewSpan ?? [0, 0],
      diagnostics,
      text: [
        `REJECTED [syntax-error] Atomic edit rolled back (${stagedFiles.size} file(s) untouched):`,
        ...diagnostics.map((d) => `  - ${d.location}: ${d.message}`),
        contextSnippet,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  // Commit all staged files to disk and run cross-repo static guard checks
  const touchedFiles: string[] = [];
  for (const [relPath, staged] of stagedFiles) {
    writeFileSync(staged.absPath, staged.updatedContent, "utf8");
    index.invalidateFile(relPath);
    touchedFiles.push(relPath);

    // Check broken relative imports
    for (const imp of staged.afterAst.imports) {
      if (imp.module.startsWith(".")) {
        const resolved = resolveRelativeImportPath(
          input.rootDir,
          relPath,
          imp.module,
          index.getFileSet()
        );
        if (!resolved && !existsSync(join(input.rootDir, relPath, "..", imp.module))) {
          diagnostics.push({
            severity: "warn",
            kind: "broken-import",
            location: `${relPath}:${imp.line}`,
            message: `Relative import '${imp.module}' does not resolve to a file on disk`,
          });
        }
      }
    }

    // Check Removed Exports & Caller Arity Drift (including internal/private functions)
    const afterSymbolsByName = new Map(staged.afterAst.symbols.map((s) => [s.name, s]));
    for (const oldSym of staged.beforeAst.symbols) {
      const newSym = afterSymbolsByName.get(oldSym.name);
      if (oldSym.exported && (!newSym || !newSym.exported)) {
        const blast = computeBlastRadius(index, relPath, oldSym.name, 4);
        if (blast.importers.length > 0 || blast.totalCallSites > 0) {
          const sites = [
            ...blast.callSites.map((c) => `${c.file}:${c.line}`),
            ...blast.importers.map((i) => `${i.file}:${i.line}`),
          ].slice(0, 4);
          diagnostics.push({
            severity: "warn",
            kind: "removed-export-still-imported",
            location: `${relPath}:${staged.firstReplacedSpan[0]}`,
            message: `Export '${oldSym.name}' was removed/unexported but is still referenced at: ${sites.join(", ")}`,
          });
        }
      } else if (
        newSym &&
        typeof oldSym.paramsCount === "number" &&
        typeof newSym.paramsCount === "number" &&
        oldSym.paramsCount !== newSym.paramsCount
      ) {
        const blast = computeBlastRadius(index, relPath, oldSym.name, 5);
        for (const site of blast.callSites) {
          // Skip warning if the caller file itself was also updated in this atomic batch!
          if (stagedFiles.has(site.file)) continue;
          if (site.argsCount > newSym.paramsCount) {
            diagnostics.push({
              severity: "warn",
              kind: "caller-arity-mismatch",
              location: `${site.file}:${site.line}`,
              message: `Caller passes ${site.argsCount} arg(s) to '${newSym.name}', which now declares ${newSym.paramsCount} param(s)`,
            });
          }
        }
      }

      // Check Removed Struct / Interface / Dataclass / Record Fields across workspace (v3.1 Contract Gate)
      if (newSym && Array.isArray(oldSym.fields) && oldSym.fields.length > 0) {
        const newFieldSet = new Set(newSym.fields ?? []);
        const removedFields = oldSym.fields.filter((fld) => !newFieldSet.has(fld));
        for (const fld of removedFields) {
          const fldAccessRe = new RegExp(`(?:\\.|->)${identifierBoundary(fld)}`, "u");
          const fldRefs: string[] = [];
          for (const candidateRel of index.getFiles()) {
            if (stagedFiles.has(candidateRel)) continue;
            const raw = index.getRawFile(candidateRel);
            if (!raw || !fldAccessRe.test(raw.content)) continue;
            const cLines = raw.content.split(/\r?\n/);
            for (let ln = 0; ln < cLines.length; ln++) {
              if (fldAccessRe.test(cLines[ln] ?? "")) {
                fldRefs.push(`${candidateRel}:${ln + 1}`);
                if (fldRefs.length >= 4) break;
              }
            }
            if (fldRefs.length >= 4) break;
          }
          if (fldRefs.length > 0) {
            diagnostics.push({
              severity: "warn",
              kind: "removed-struct-field-still-referenced",
              location: `${relPath}:${newSym.line}`,
              message: `Field '${oldSym.name}.${fld}' was removed/renamed but is still accessed at: ${fldRefs.join(", ")}`,
            });
          }
        }
      }
    }
  }

  markSessionFilesEdited(input.rootDir, "main", touchedFiles);

  // Check learned user habits (Co-Edit Partner Warnings + Auto-Verify Hook)
  let autoVerifyLine: string | undefined;
  if (input.habitHook) {
    const habitOut = input.habitHook(touchedFiles);
    for (const hint of habitOut.coEditHints) {
      diagnostics.push({
        severity: "warn",
        kind: "co-edit-habit",
        location: primaryFile,
        message: hint,
      });
    }
    if (habitOut.autoVerifySummary) {
      autoVerifyLine = habitOut.autoVerifySummary;
    }
  }

  const diagLines =
    diagnostics.length > 0
      ? ["Static Guard & Habit Warnings:", ...diagnostics.map((d) => `  ! [${d.kind}] ${d.location}: ${d.message}`)]
      : [];

  const summaryHeader =
    touchedFiles.length > 1
      ? `OK [batch-edited ${touchedFiles.length} files: ${touchedFiles.join(", ")}] (${diagnostics.length === 0 ? "AST syntax & callers clean" : `${diagnostics.length} warning(s)`})`
      : `OK [edited ${primaryFile}] L${primaryStaged!.firstReplacedSpan[0]}-${primaryStaged!.firstReplacedSpan[1]} -> L${primaryStaged!.firstNewSpan[0]}-${primaryStaged!.firstNewSpan[1]} (${diagnostics.length === 0 ? "AST syntax & callers clean" : `${diagnostics.length} warning(s)`})`;

  return {
    ok: true,
    file: primaryFile,
    touchedFiles,
    mode: specs.length > 1 ? "batch" : primaryStaged!.mode,
    replacedSpan: primaryStaged!.firstReplacedSpan,
    newSpan: primaryStaged!.firstNewSpan,
    diagnostics,
    text: [summaryHeader, ...(autoVerifyLine ? [autoVerifyLine] : []), ...diagLines].join("\n"),
  };
}
