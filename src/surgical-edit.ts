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
 *      spending 0 LLM output tokens on repetitive find-and-replace.
 *   3. Instant Post-Edit Static Guard: Checks AST syntax, broken relative imports,
 *      removed exports still imported elsewhere, and caller parameter arity drift.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSourceFile, resolveRelativeImportPath } from "./ast-engine.js";
import { computeBlastRadius } from "./blast-radius.js";
import { markSessionFilesEdited } from "./circuit-breaker.js";
import { formatNumberedLines, getWorkspaceAstIndex } from "./slicer.js";

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const relDecl = declFile.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) {
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

  const sym = declData.ast.symbols.find((s) => s.name === oldName);
  if (!sym) {
    return {
      ok: false,
      file: relDecl,
      touchedFiles: [],
      mode: "rename",
      replacedSpan: [0, 0],
      newSpan: [0, 0],
      diagnostics: [],
      text: `ERR [symbol-not-found] '${oldName}' in ${relDecl}`,
    };
  }

  // Collect all files to update: declaration file + importers + callers + type-referencing files
  const blast = computeBlastRadius(index, relDecl, oldName, 100);
  const candidateFiles = new Set<string>([
    relDecl,
    ...blast.importers.map((i) => i.file),
    ...blast.callSites.map((c) => c.file),
  ]);
  const typeCheckRe = new RegExp(`\\b${escapeRegExp(oldName)}\\b`);
  for (const relPath of index.getFiles()) {
    if (candidateFiles.has(relPath)) continue;
    const raw = index.getRawFile(relPath);
    if (!raw || !typeCheckRe.test(raw.content)) continue;
    const fData = index.getFileAnalysis(relPath);
    if (!fData) continue;
    if (
      fData.ast.symbols.some((s) => s.referencedTypes.includes(oldName)) ||
      fData.ast.imports.some((imp) => imp.importedNames.includes(oldName) || imp.importedNames.includes("*"))
    ) {
      candidateFiles.add(relPath);
    }
  }

  const wordRe = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, "g");
  const stagedWrites = new Map<string, { absPath: string; content: string; replacements: number }>();
  const diagnostics: StaticGuardDiagnostic[] = [];

  for (const relPath of candidateFiles) {
    const absPath = join(rootDir, relPath);
    if (!existsSync(absPath)) continue;
    const raw = readFileSync(absPath, "utf8");
    let count = 0;
    const updated = raw.replace(wordRe, () => {
      count += 1;
      return newName;
    });
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

  let totalOccurrences = 0;
  const touchedFiles: string[] = [];
  for (const [relPath, item] of stagedWrites) {
    writeFileSync(item.absPath, item.content, "utf8");
    index.invalidateFile(relPath);
    touchedFiles.push(relPath);
    totalOccurrences += item.replacements;
  }

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

  const index = getWorkspaceAstIndex(input.rootDir);

  // Group edits by normalized file path so multiple edits to the same file
  // are resolved against the original AST and applied bottom-up (no line drift!)
  const byFile = new Map<string, SingleEditSpec[]>();
  for (const spec of specs) {
    const rel = (spec.file || input.file || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!rel) continue;
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
    const absPath = join(input.rootDir, relPath);
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
    const originalLines = originalContent.split(/\r?\n/);
    const beforeAst = analyzeSourceFile(relPath, originalContent);

    const patches: ResolvedPatch[] = [];
    let currentContent = originalContent;

    for (const spec of fileSpecs) {
      const replacement = spec.newCode ?? "";
      if (spec.symbol) {
        const sym = beforeAst.symbols.find((s) => s.name === spec.symbol);
        if (!sym) {
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
        const idx = currentContent.indexOf(spec.oldCode);
        if (idx === -1) {
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
        const prefix = currentContent.slice(0, idx);
        const sLine = prefix.split(/\r?\n/).length;
        const eLine = sLine + spec.oldCode.split(/\r?\n/).length - 1;
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

    const updatedContent = workingLines.join("\n");
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
          const fldAccessRe = new RegExp(`(?:\\.|->)\\b${escapeRegExp(fld)}\\b`);
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
