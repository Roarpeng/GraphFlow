/**
 * GraphFlow 3.0 — Pillar 2A: Blast-Radius Call-Site Micro-Snippets (`blast-radius.ts`)
 *
 * Uses a two-stage pipeline for <50ms workspace-wide call-site discovery across
 * TypeScript/JS, Python, Go, Rust, C/C++, and C#:
 *   Stage 1 (Fast Word-Boundary Pre-filter): Checks if `raw.content` contains
 *           `symbolName` as a whole identifier (`\bsymbolName\b`).
 *   Stage 2 (AST Verification): Parses only the candidate files that pass Stage 1
 *           and extracts exact call sites + 3-line numbered micro-snippets.
 */

import { dirname, extname } from "node:path";
import { formatNumberedLines, type getWorkspaceAstIndex } from "./slicer.js";

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const IMPLICIT_PACKAGE_EXTS = new Set([".go", ".cs", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"]);

export function computeBlastRadius(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  targetFile: string,
  symbolName: string,
  maxCallSites = 6
): SymbolBlastRadius {
  const callSites: CallSiteSnippet[] = [];
  const importers: ImporterSite[] = [];
  let totalCallSites = 0;

  const wordRe = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`);
  const targetDir = dirname(targetFile);
  const targetExt = extname(targetFile).toLowerCase();

  // Prioritize production files ahead of tests/ and benchmarks/
  const allFiles = [...index.getFiles()].sort((a, b) => {
    const aProd = a.startsWith("tests/") || a.startsWith("benchmarks/") ? 1 : 0;
    const bProd = b.startsWith("tests/") || b.startsWith("benchmarks/") ? 1 : 0;
    return aProd - bProd || a.localeCompare(b);
  });

  for (const relPath of allFiles) {
    if (
      callSites.length >= maxCallSites &&
      (relPath.startsWith("tests/") || relPath.startsWith("benchmarks/"))
    ) {
      continue;
    }

    const raw = index.getRawFile(relPath);
    if (!raw || !wordRe.test(raw.content)) continue;

    const fileData = index.getFileAnalysis(relPath);
    if (!fileData) continue;

    const isSameFile = relPath === targetFile;
    const isSamePackageScope =
      IMPLICIT_PACKAGE_EXTS.has(targetExt) &&
      (dirname(relPath) === targetDir || extname(relPath).toLowerCase() === targetExt);

    const matchingImport = fileData.ast.imports.find(
      (imp) => imp.importedNames.includes(symbolName) || imp.importedNames.includes("*")
    );
    if (!isSameFile && matchingImport) {
      importers.push({
        file: relPath,
        line: matchingImport.line,
        rawImport: matchingImport.raw,
      });
    }

    const fileCalls = fileData.ast.calls.filter((c) => c.callee === symbolName);
    if (fileCalls.length > 0 && (isSameFile || isSamePackageScope || matchingImport)) {
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
