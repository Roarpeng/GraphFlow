/**
 * GraphFlow 3.0 — Pillar 1: Precise Context Slicer & AST Skeleton Folding (`gf_read`)
 *
 * Supports TypeScript/JavaScript, Python, Go, Rust, C/C++, and C#.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  SUPPORTED_SOURCE_EXTS,
  analyzeSourceFile,
  resolveRelativeImportPath,
  type AstSymbol,
  type FileAstAnalysis,
} from "./ast-engine.js";
import { computeBlastRadius, formatBlastRadiusText } from "./blast-radius.js";
import {
  SUPPORTED_DOC_EXTS,
  buildDocCodeLinks,
  findLinkedDocsForSymbol,
  generateCrossAgentBrief,
  parseProjectDocument,
} from "./doc-graph.js";
import {
  CHINESE_TYPO_NORMALIZATION,
  CJK_ENGINEERING_GLOSSARY,
  CJK_SYNONYM_CLUSTERS,
  isFuzzyTokenMatch,
  normalizeChineseTypos,
  segmentChinese,
  stemEnglishWord,
  toPinyin,
  tokenizeBilingualQuery,
  tokenizeEnglish,
  type BilingualQueryPlan,
} from "./tokenizer.js";

export {
  CHINESE_TYPO_NORMALIZATION,
  CJK_ENGINEERING_GLOSSARY,
  CJK_SYNONYM_CLUSTERS,
  isFuzzyTokenMatch,
  normalizeChineseTypos,
  segmentChinese,
  stemEnglishWord,
  toPinyin,
  tokenizeBilingualQuery,
  tokenizeEnglish,
  type BilingualQueryPlan,
};

export interface ReadOptions {
  rootDir: string;
  targets?: string[];
  query?: string;
  topK?: number;
  includeCallers?: boolean;
  includeSkeleton?: boolean;
  macroHintLookup?: (keys: string[]) => string | undefined;
}

export interface SliceResult {
  text: string;
  estimatedTokens: number;
  rawFileTokens: number;
  resolvedKeys: string[];
  matchedSymbols: Array<{ file: string; name: string; kind: string; line: number; endLine: number }>;
}


const MAX_SCAN_FILES = 5000;
const MAX_SCAN_DEPTH = 12;

/**
 * Resolves a safe workspace root directory, guarding against unexpanded IDE
 * placeholders (`${workspaceFolder}`), file paths passed as rootDir, or bare `$HOME`.
 */
export function resolveSafeWorkspaceRoot(rawRootDir?: string, fallbackRootDir: string = process.cwd()): string {
  const candidate = (rawRootDir ?? "").trim();
  if (
    !candidate ||
    candidate.includes("${") ||
    candidate === "~" ||
    candidate === "."
  ) {
    return resolve(fallbackRootDir);
  }
  const resolved = resolve(candidate);
  try {
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      return dirname(resolved);
    }
  } catch {
    // ignore
  }
  return resolved;
}

/**
 * Normalizes a caller-supplied file path (relative, Windows backslash, or absolute inside rootDir)
 * into a safe workspace-relative POSIX path. Returns `undefined` if the path escapes `rootDir` (`..`).
 */
export function normalizeWorkspaceRelPath(rootDir: string, inputPath: string): string | undefined {
  const raw = inputPath.trim();
  if (!raw) return undefined;
  const safeRoot = resolve(rootDir);
  const normalizedRaw = raw.replace(/\\/g, "/");
  const absTarget = isAbsolute(normalizedRaw)
    ? resolve(normalizedRaw)
    : resolve(safeRoot, normalizedRaw);
  const rel = relative(safeRoot, absTarget).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

/**
 * Resolves symbol(s) in a file AST supporting both bare `methodName` (returns all matches)
 * and scoped `ClassName.methodName` or `ClassName::methodName` disambiguation.
 */
export function findMatchingSymbolsInAst(ast: FileAstAnalysis, symQuery: string): AstSymbol[] {
  const cleaned = symQuery.trim().replace("::", ".");
  if (cleaned.includes(".")) {
    const [containerName, memberName] = cleaned.split(".", 2);
    // 1. Check explicit parentClass (Go receiver, Rust impl, C++ Class::method, Python/C# class)
    const byParent = ast.symbols.filter(
      (s) => s.name === memberName && s.parentClass === containerName
    );
    if (byParent.length > 0) return byParent;

    // 2. Check line containment inside class/struct/interface block (TS/JS/Python/C#/C++)
    const container = ast.symbols.find(
      (s) =>
        s.name === containerName &&
        (s.kind === "class" || s.kind === "interface" || s.kind === "struct" || s.kind === "type")
    );
    if (container) {
      const scoped = ast.symbols.filter(
        (s) =>
          s.name === memberName &&
          s.line >= container.line &&
          s.endLine <= container.endLine
      );
      if (scoped.length > 0) return scoped;
    }
  }
  return ast.symbols.filter((s) => s.name === cleaned || s.name === symQuery.trim());
}

const IGNORED_DIRS = new Set([
  "vendor", "third_party", ".turbo", ".nuxt", ".svelte-kit", ".cache", "cmake-build-debug",
  "node_modules", ".git", "dist", "build", "coverage", ".graphflow",
  ".graphflow-cache", "graphflow-out", "wasm", ".next", "out",
  "__pycache__", ".venv", "venv", "target", "bin", "obj",
]);

/**
 * In-memory workspace AST index cache with separate raw-text and lazy-AST tiers
 * so lexical pre-filters run in <5ms across hundreds of files.
 */
class WorkspaceAstIndex {
  private rawCache = new Map<string, { mtimeMs: number; size: number; content: string; checkedAt: number }>();
  private astCache = new Map<string, { mtimeMs: number; size: number; ast: FileAstAnalysis }>();
  private lastScanMs = 0;
  private scannedFiles: string[] = [];
  private scannedFileSet = new Set<string>();

  constructor(public readonly rootDir: string) {}

  getFiles(forceRescan = false): string[] {
    const now = Date.now();
    if (!forceRescan && this.scannedFiles.length > 0 && now - this.lastScanMs < 5_000) {
      return this.scannedFiles;
    }
    const out: string[] = [];
    const isBareHome = resolve(this.rootDir) === resolve(homedir());
    if (isBareHome) {
      return out;
    }
    const walk = (dir: string, depth: number) => {
      if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_SCAN_FILES) break;
        if (entry.name.startsWith(".") && entry.name !== ".trae") continue;
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && SUPPORTED_SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
          out.push(relative(this.rootDir, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(this.rootDir, 0);
    out.sort();
    this.scannedFiles = out;
    this.scannedFileSet = new Set(out);
    this.lastScanMs = now;
    return out;
  }

  getFileSet(): ReadonlySet<string> {
    this.getFiles();
    return this.scannedFileSet;
  }

  getRawFile(relPath: string): { content: string; size: number; mtimeMs: number } | undefined {
    const normalized = normalizeWorkspaceRelPath(this.rootDir, relPath);
    if (!normalized) return undefined;
    const now = Date.now();
    const cached = this.rawCache.get(normalized);
    if (cached && now - cached.checkedAt < 5_000) {
      return cached;
    }
    const absPath = join(this.rootDir, normalized);
    try {
      const st = statSync(absPath);
      if (!st.isFile() || st.size > 2_000_000) return undefined;
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        cached.checkedAt = now;
        return cached;
      }
      const content = readFileSync(absPath, "utf8");
      const entry = { mtimeMs: st.mtimeMs, size: st.size, content, checkedAt: now };
      this.rawCache.set(normalized, entry);
      return entry;
    } catch {
      this.rawCache.delete(normalized);
      this.astCache.delete(normalized);
      return undefined;
    }
  }

  getFileAnalysis(relPath: string): { content: string; ast: FileAstAnalysis; size: number } | undefined {
    const normalized = normalizeWorkspaceRelPath(this.rootDir, relPath);
    if (!normalized) return undefined;
    const raw = this.getRawFile(normalized);
    if (!raw) return undefined;
    const cachedAst = this.astCache.get(normalized);
    if (cachedAst && cachedAst.mtimeMs === raw.mtimeMs && cachedAst.size === raw.size) {
      return { content: raw.content, ast: cachedAst.ast, size: raw.size };
    }
    const ast = analyzeSourceFile(normalized, raw.content);
    this.astCache.set(normalized, { mtimeMs: raw.mtimeMs, size: raw.size, ast });
    return { content: raw.content, ast, size: raw.size };
  }

  invalidateFile(relPath: string): void {
    const normalized = normalizeWorkspaceRelPath(this.rootDir, relPath) ?? relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    this.rawCache.delete(normalized);
    this.astCache.delete(normalized);
    this.lastScanMs = 0;
  }
}

const indexByRoot = new Map<string, WorkspaceAstIndex>();

export function getWorkspaceAstIndex(rootDir: string): WorkspaceAstIndex {
  const safeRoot = resolveSafeWorkspaceRoot(rootDir);
  let idx = indexByRoot.get(safeRoot);
  if (!idx) {
    idx = new WorkspaceAstIndex(safeRoot);
    indexByRoot.set(safeRoot, idx);
  }
  return idx;
}

export function formatNumberedLines(lines: string[], startLine: number, endLine: number): string {
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, endLine);
  const out: string[] = [];
  for (let ln = s; ln <= e; ln++) {
    out.push(`${String(ln).padStart(4)}: ${lines[ln - 1] ?? ""}`);
  }
  return out.join("\n");
}

export function foldFileSkeleton(
  content: string,
  ast: FileAstAnalysis,
  expandSymbols: ReadonlySet<string> = new Set()
): string {
  const lines = content.split(/\r?\n/);
  const foldRanges = new Map<number, { endLine: number; replacement: string }>();
  const isPython = ast.backend === "python-ast";

  for (const sym of ast.symbols) {
    if (expandSymbols.has(sym.name)) continue;
    const span = sym.endLine - sym.line + 1;
    if ((sym.kind === "function" || sym.kind === "method") && span > 4) {
      const sigLine = (lines[sym.line - 1] ?? sym.signature).trimEnd();
      if (isPython) {
        foldRanges.set(sym.line, {
          endLine: sym.endLine,
          replacement: `${String(sym.line).padStart(4)}: ${sigLine} ...  # [lines ${sym.line + 1}-${sym.endLine} folded]`,
        });
      } else {
        const hasOpenBrace = sigLine.includes("{");
        const suffix = hasOpenBrace
          ? ` /* ... lines ${sym.line + 1}-${sym.endLine} folded ... */ }`
          : ` { /* ... lines ${sym.line + 1}-${sym.endLine} folded ... */ }`;
        foldRanges.set(sym.line, {
          endLine: sym.endLine,
          replacement: `${String(sym.line).padStart(4)}: ${sigLine}${suffix}`,
        });
      }
    } else if ((sym.kind === "interface" || sym.kind === "type" || sym.kind === "enum") && span > 20) {
      const sigLine = (lines[sym.line - 1] ?? sym.signature).trimEnd();
      const suffix = isPython
        ? ` ...  # [lines ${sym.line + 1}-${sym.endLine} folded (${span} lines)]`
        : ` /* ... lines ${sym.line + 1}-${sym.endLine} folded (${span} lines) ... */ }`;
      foldRanges.set(sym.line, {
        endLine: sym.endLine,
        replacement: `${String(sym.line).padStart(4)}: ${sigLine}${suffix}`,
      });
    }
  }

  const out: string[] = [];
  let ln = 1;
  let consecutiveBlanks = 0;
  while (ln <= lines.length) {
    const fold = foldRanges.get(ln);
    if (fold) {
      consecutiveBlanks = 0;
      out.push(fold.replacement);
      ln = fold.endLine + 1;
      continue;
    }
    const raw = lines[ln - 1] ?? "";
    if (raw.trim() === "") {
      consecutiveBlanks += 1;
      if (consecutiveBlanks <= 1) {
        out.push(`${String(ln).padStart(4)}:`);
      }
    } else {
      consecutiveBlanks = 0;
      out.push(`${String(ln).padStart(4)}: ${raw}`);
    }
    ln += 1;
  }
  return out.join("\n");
}

function isTypeDefinitionKind(kind: AstSymbol["kind"]): boolean {
  return kind === "interface" || kind === "type" || kind === "enum" || kind === "class";
}

function resolveTypeClosure(
  index: WorkspaceAstIndex,
  fileAst: FileAstAnalysis,
  fileContent: string,
  targetSymbols: AstSymbol[],
  maxTypes = 5
): string[] {
  const neededTypes = new Set<string>();
  const targetNames = new Set(targetSymbols.map((s) => s.name));
  for (const sym of targetSymbols) {
    for (const t of sym.referencedTypes) {
      if (!targetNames.has(t)) neededTypes.add(t);
    }
  }
  if (neededTypes.size === 0) return [];

  const blocks: string[] = [];
  const fileLines = fileContent.split(/\r?\n/);

  // 1. Same-file type definitions
  for (const sym of fileAst.symbols) {
    if (blocks.length >= maxTypes) break;
    if (neededTypes.has(sym.name) && isTypeDefinitionKind(sym.kind)) {
      neededTypes.delete(sym.name);
      const end = Math.min(sym.endLine, sym.line + 30);
      blocks.push(
        `// [Type Closure] ${fileAst.relPath}:${sym.line}-${sym.endLine} (${sym.kind} ${sym.name})\n` +
          formatNumberedLines(fileLines, sym.line, end)
      );
    }
  }

  // 2. Explicitly imported modules (TS/JS, Python, Rust, C/C++ #include)
  if (neededTypes.size > 0 && blocks.length < maxTypes) {
    for (const imp of fileAst.imports) {
      if (blocks.length >= maxTypes || neededTypes.size === 0) break;
      const matchingImportNames = imp.importedNames.includes("*")
        ? Array.from(neededTypes)
        : imp.importedNames.filter((n) => neededTypes.has(n));
      if (matchingImportNames.length === 0) continue;
      const resolvedRel = resolveRelativeImportPath(index.rootDir, fileAst.relPath, imp.module, index.getFileSet());
      if (!resolvedRel) continue;
      const targetFile = index.getFileAnalysis(resolvedRel);
      if (!targetFile) continue;
      const targetLines = targetFile.content.split(/\r?\n/);
      for (const name of matchingImportNames) {
        const typeSym = targetFile.ast.symbols.find((s) => s.name === name && isTypeDefinitionKind(s.kind));
        if (typeSym) {
          neededTypes.delete(name);
          const end = Math.min(typeSym.endLine, typeSym.line + 30);
          blocks.push(
            `// [Type Closure] ${resolvedRel}:${typeSym.line}-${typeSym.endLine} (${typeSym.kind} ${typeSym.name})\n` +
              formatNumberedLines(targetLines, typeSym.line, end)
          );
        }
      }
    }
  }

  // 3. Same-package / same-namespace / header fallback (Go package, C# namespace, C/C++ header, Python/Rust module)
  if (neededTypes.size > 0 && blocks.length < maxTypes) {
    const fromDir = dirname(fileAst.relPath);
    const candidateFiles = [...index.getFiles()].sort((a, b) => {
      const aSameDir = dirname(a) === fromDir ? 0 : 1;
      const bSameDir = dirname(b) === fromDir ? 0 : 1;
      return aSameDir - bSameDir || a.localeCompare(b);
    });
    for (const relPath of candidateFiles) {
      if (blocks.length >= maxTypes || neededTypes.size === 0) break;
      if (relPath === fileAst.relPath) continue;
      const raw = index.getRawFile(relPath);
      if (!raw) continue;
      const hasAnyNeeded = Array.from(neededTypes).some((t) => raw.content.includes(t));
      if (!hasAnyNeeded) continue;
      const targetFile = index.getFileAnalysis(relPath);
      if (!targetFile) continue;
      const targetLines = targetFile.content.split(/\r?\n/);
      for (const name of Array.from(neededTypes)) {
        const typeSym = targetFile.ast.symbols.find((s) => s.name === name && isTypeDefinitionKind(s.kind));
        if (typeSym) {
          neededTypes.delete(name);
          const end = Math.min(typeSym.endLine, typeSym.line + 30);
          blocks.push(
            `// [Type Closure] ${relPath}:${typeSym.line}-${typeSym.endLine} (${typeSym.kind} ${typeSym.name})\n` +
              formatNumberedLines(targetLines, typeSym.line, end)
          );
        }
      }
    }
  }

  return blocks;
}

export function tokenizeQuery(query: string): {
  exactIdentifiers: string[];
  subTokens: string[];
  cjkTokens: string[];
} {
  const plan = tokenizeBilingualQuery(query);
  return {
    exactIdentifiers: plan.exactIdentifiers,
    subTokens: plan.englishWords,
    cjkTokens: plan.chineseWords,
  };
}

export function executeSurgicalRead(options: ReadOptions): SliceResult {
  const index = getWorkspaceAstIndex(options.rootDir);
  const includeCallers = options.includeCallers !== false;
  const resolvedKeys: string[] = [];
  const matchedSymbols: SliceResult["matchedSymbols"] = [];
  const countedRawFiles = new Set<string>();
  let rawFileTokens = 0;

  const accountRawFile = (relPath: string, sizeBytes: number) => {
    if (!countedRawFiles.has(relPath)) {
      countedRawFiles.add(relPath);
      rawFileTokens += Math.ceil(sizeBytes / 4);
    }
  };

  const sections: string[] = [];

  if (options.targets && options.targets.length > 0) {
    for (const rawTarget of options.targets) {
      const target = rawTarget.trim();
      if (!target) continue;
      if (target === "@brief" || target === "brief") {
        sections.push(generateCrossAgentBrief(index));
        resolvedKeys.push("@brief");
        continue;
      }
      const targetExt = extname(target.split("#")[0]!.split(":")[0]!).toLowerCase();
      if (SUPPORTED_DOC_EXTS.has(targetExt)) {
        const relDoc = normalizeWorkspaceRelPath(index.rootDir, target.split("#")[0]!);
        if (relDoc && existsSync(join(index.rootDir, relDoc))) {
          const docSecs = parseProjectDocument(relDoc, join(index.rootDir, relDoc));
          const allLinks = buildDocCodeLinks(index, docSecs);
          const docLines = [`### [Development Spec Document] ${relDoc} (${docSecs.length} section(s))`];
          for (const sec of docSecs) {
            docLines.push(`#### ${sec.title} (L${sec.startLine}-${sec.endLine})`);
            docLines.push(sec.summary);
            const secLinks = allLinks.filter((l) => l.docPath === relDoc && l.sectionTitle === sec.title);
            for (const sl of secLinks.slice(0, 3)) {
              docLines.push(`  -> [Linked Code] ${sl.codeFile}#${sl.symbolName} (${sl.reason})`);
            }
          }
          sections.push(docLines.join("\n"));
          resolvedKeys.push(relDoc);
          continue;
        }
      }

      if (target.includes("#")) {
        const [filePart, symPart] = target.split("#", 2);
        const fileData = index.getFileAnalysis(filePart!);
        if (!fileData) {
          sections.push(`# [NOT FOUND] File not found: ${filePart}`);
          continue;
        }
        accountRawFile(fileData.ast.relPath, fileData.size);
        const matchedList = findMatchingSymbolsInAst(fileData.ast, symPart!);
        if (matchedList.length === 0) {
          const available = fileData.ast.symbols.map((s) => `${s.name}(L${s.line})`).join(", ");
          sections.push(
            `# [SYMBOL NOT FOUND] ${symPart} in ${fileData.ast.relPath}\nAvailable symbols: ${available || "none"}`
          );
          continue;
        }

        const lines = fileData.content.split(/\r?\n/);
        for (const sym of matchedList) {
          const key = `${fileData.ast.relPath}#${sym.name}`;
          if (!resolvedKeys.includes(key)) resolvedKeys.push(key);
          matchedSymbols.push({
            file: fileData.ast.relPath,
            name: sym.name,
            kind: sym.kind,
            line: sym.line,
            endLine: sym.endLine,
          });

          const blockLines: string[] = [
            `### ${fileData.ast.relPath}:${sym.line}-${sym.endLine} [${sym.exported ? "export " : ""}${sym.kind} ${sym.name}]`,
            formatNumberedLines(lines, sym.line, sym.endLine),
          ];

          const typeClosure = resolveTypeClosure(index, fileData.ast, fileData.content, [sym]);
          if (typeClosure.length > 0) {
            blockLines.push(...typeClosure);
          }

          if (includeCallers) {
            const blast = computeBlastRadius(index, fileData.ast.relPath, sym.name);
            const blastText = formatBlastRadiusText(blast);
            if (blastText) blockLines.push(blastText);
          }

          const linkedDocs = findLinkedDocsForSymbol(index, fileData.ast.relPath, sym.name, 2);
          for (const ld of linkedDocs) {
            blockLines.push(
              `// [Linked Spec Doc] ${ld.docPath}#${ld.sectionTitle} (${ld.reason}): ${ld.summary}`
            );
          }

          if (options.includeSkeleton) {
            blockLines.push(
              `// --- Rest of ${fileData.ast.relPath} (AST Skeleton Folded) ---`,
              foldFileSkeleton(fileData.content, fileData.ast, new Set([sym.name]))
            );
          }

          sections.push(blockLines.join("\n"));
        }
        continue;
      }

      const rangeMatch = target.match(/^(.+?):(\d+)(?:-(\d+))?$/);
      if (rangeMatch) {
        const filePart = rangeMatch[1]!;
        const startLine = Number.parseInt(rangeMatch[2]!, 10);
        const endLine = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : startLine + 40;
        const fileData = index.getFileAnalysis(filePart);
        if (!fileData) {
          sections.push(`# [NOT FOUND] File not found: ${filePart}`);
          continue;
        }
        accountRawFile(fileData.ast.relPath, fileData.size);
        resolvedKeys.push(`${fileData.ast.relPath}:${startLine}-${endLine}`);
        const lines = fileData.content.split(/\r?\n/);
        sections.push(
          `### ${fileData.ast.relPath}:${startLine}-${Math.min(lines.length, endLine)} (total ${lines.length}L)\n` +
            formatNumberedLines(lines, startLine, endLine)
        );
        continue;
      }

      const fileData = index.getFileAnalysis(target);
      if (!fileData) {
        sections.push(`# [NOT FOUND] File not found: ${target}`);
        continue;
      }
      accountRawFile(fileData.ast.relPath, fileData.size);
      resolvedKeys.push(fileData.ast.relPath);
      for (const s of fileData.ast.symbols) {
        matchedSymbols.push({
          file: fileData.ast.relPath,
          name: s.name,
          kind: s.kind,
          line: s.line,
          endLine: s.endLine,
        });
      }
      sections.push(
        `### ${fileData.ast.relPath} (AST Skeleton View, ${fileData.ast.totalLines}L, ${fileData.ast.symbols.length} symbols)\n` +
          foldFileSkeleton(fileData.content, fileData.ast)
      );
    }
  } else if (options.query) {
    const topK = options.topK ?? 3;
    // Step 1: Segment & tokenize the user query (Chinese Bi-MM + ICU Segmenter & English camelCase + Stemmer)
    const plan = tokenizeBilingualQuery(options.query);
    const exactLower = new Set(plan.exactIdentifiers.map((s) => s.toLowerCase()));
    const queryWords = plan.englishWords;
    const queryStems = new Set(plan.englishStems);
    const cjkWords = plan.chineseWords;
    const cjkPhrases = plan.chinesePhrases;

    interface ScoredCandidate {
      relPath: string;
      sym: AstSymbol;
      score: number;
      fileContent: string;
      fileAst: FileAstAnalysis;
      fileSize: number;
    }

    const candidates: ScoredCandidate[] = [];
    for (const relPath of index.getFiles(true)) {
      const isTestFile =
        relPath.startsWith("tests/") ||
        relPath.startsWith("benchmarks/") ||
        relPath.includes(".test.");
      if (isTestFile && !plan.wantsTests) continue;

      const raw = index.getRawFile(relPath);
      if (!raw) continue;
      const contentLower = raw.content.toLowerCase();
      const pathLower = relPath.toLowerCase();

      const hasAnyToken =
        queryWords.some((tok) => pathLower.includes(tok) || contentLower.includes(tok)) ||
        Array.from(queryStems).some((st) => pathLower.includes(st) || contentLower.includes(st)) ||
        cjkWords.some((cjk) => raw.content.includes(cjk) || relPath.includes(cjk)) ||
        Array.from(exactLower).some((id) => contentLower.includes(id));
      if (!hasAnyToken) continue;

      const fileData = index.getFileAnalysis(relPath);
      if (!fileData) continue;
      const fileLines = fileData.content.split(/\r?\n/);

      let pathScore = 0;
      for (const id of exactLower) {
        if (pathLower.includes(id)) pathScore += 12;
      }
      for (const tok of queryWords) {
        if (pathLower.includes(tok)) pathScore += 3;
      }
      for (const cjk of cjkWords) {
        if (relPath.includes(cjk)) pathScore += 8;
      }

      for (const sym of fileData.ast.symbols) {
        let score = pathScore;
        const symLower = sym.name.toLowerCase();
        const sigLower = sym.signature.toLowerCase();
        // Tokenize & stem the symbol identifier itself for morphological stem matching
        const symTokenized = tokenizeEnglish(sym.name);
        const symWordSet = new Set(symTokenized.words);
        const symStemSet = new Set(symTokenized.stems);

        if (exactLower.has(symLower)) {
          score += 50;
        } else {
          for (const id of exactLower) {
            if (symLower.includes(id)) score += 20;
          }
        }

        for (const tok of queryWords) {
          if (symLower === tok || symWordSet.has(tok)) score += 15;
          else if (symLower.includes(tok)) score += tok.length >= 5 ? 14 : 6;
          else if (sigLower.includes(tok)) score += 2;
        }

        // Morphological stem match (e.g. query "canceling expiring orders" -> stems ["cancel", "expir", "order"] matches cancelExpiredOrder)
        for (const st of queryStems) {
          if (symStemSet.has(st)) score += 10;
          else if (st.length >= 4 && symTokenized.stems.some((ss) => isFuzzyTokenMatch(st, ss))) {
            score += 8;
          }
        }

        // Segmented Chinese word & phrase match across symbol name, JSDoc/docstring window, and symbol body
        if (cjkWords.length > 0 || cjkPhrases.length > 0) {
          const docStart = Math.max(0, sym.line - 7);
          const docWindow = fileLines
            .slice(docStart, Math.min(fileLines.length, sym.line + 4))
            .join("\n");
          const bodyWindow = fileLines
            .slice(Math.max(0, sym.line - 1), Math.min(fileLines.length, sym.endLine))
            .join("\n");

          for (const phrase of cjkPhrases) {
            if (docWindow.includes(phrase) || bodyWindow.includes(phrase)) {
              score += 20;
            }
          }
          for (const cjk of cjkWords) {
            if (sym.name.includes(cjk)) {
              score += 25;
            } else if (docWindow.includes(cjk)) {
              score += 12;
            } else if (bodyWindow.includes(cjk)) {
              score += 6;
            }
          }
        }

        if (sym.exported) score += 2;

        if (score >= 6) {
          candidates.push({
            relPath,
            sym,
            score,
            fileContent: fileData.content,
            fileAst: fileData.ast,
            fileSize: fileData.size,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.sym.line - b.sym.line);

    const picked: ScoredCandidate[] = [];
    const perFileCount = new Map<string, number>();
    for (const c of candidates) {
      if (picked.length >= topK) break;
      const cnt = perFileCount.get(c.relPath) ?? 0;
      if (cnt >= Math.max(2, topK)) continue;
      perFileCount.set(c.relPath, cnt + 1);
      picked.push(c);
    }

    if (picked.length === 0) {
      sections.push(`# No symbols matched query: "${options.query}"`);
    } else {
      const navLines: string[] = [`# Locate & Slice (${picked.length} sliced, ${candidates.length} total hits)`];
      for (const c of candidates.slice(0, 8)) {
        const mark = picked.includes(c) ? "[SLICED]" : "[OTHER] ";
        navLines.push(
          `${mark} ${c.relPath}:${c.sym.line}-${c.sym.endLine} (${c.sym.kind} ${c.sym.name})`
        );
      }
      sections.push(navLines.join("\n"));

      for (const c of picked) {
        accountRawFile(c.relPath, c.fileSize);
        const key = `${c.relPath}#${c.sym.name}`;
        resolvedKeys.push(key);
        matchedSymbols.push({
          file: c.relPath,
          name: c.sym.name,
          kind: c.sym.kind,
          line: c.sym.line,
          endLine: c.sym.endLine,
        });

        const lines = c.fileContent.split(/\r?\n/);
        const maxSpanEnd = Math.min(c.sym.endLine, c.sym.line + 75);
        const truncatedNote =
          c.sym.endLine > maxSpanEnd
            ? `\n// ... [lines ${maxSpanEnd + 1}-${c.sym.endLine} omitted; call gf_read(targets=["${c.relPath}:${maxSpanEnd + 1}-${c.sym.endLine}"]) if needed]`
            : "";

        const block: string[] = [
          `### ${c.relPath}:${c.sym.line}-${c.sym.endLine} [${c.sym.exported ? "export " : ""}${c.sym.kind} ${c.sym.name}]`,
          formatNumberedLines(lines, c.sym.line, maxSpanEnd) + truncatedNote,
        ];

        const typeClosure = resolveTypeClosure(index, c.fileAst, c.fileContent, [c.sym], 3);
        if (typeClosure.length > 0) {
          block.push(...typeClosure);
        }

        if (includeCallers) {
          const blast = computeBlastRadius(index, c.relPath, c.sym.name, 4);
          const blastText = formatBlastRadiusText(blast);
          if (blastText) block.push(blastText);
        }

        sections.push(block.join("\n"));
      }
    }
  } else {
    sections.push(generateCrossAgentBrief(index));
    resolvedKeys.push("@brief");
  }

  if (options.macroHintLookup && resolvedKeys.length > 0) {
    const hint = options.macroHintLookup(resolvedKeys);
    if (hint) {
      sections.unshift(hint);
    }
  }

  const text = sections.join("\n\n").trim();
  const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));
  return {
    text,
    estimatedTokens,
    rawFileTokens: Math.max(estimatedTokens, rawFileTokens),
    resolvedKeys,
    matchedSymbols,
  };
}
