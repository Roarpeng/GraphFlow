/**
 * GraphFlow 3.0 — Pillar 1: Precise Context Slicer & AST Skeleton Folding (`gf_read`)
 *
 * Supports TypeScript/JavaScript, Python, Go, Rust, C/C++, and C#.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
import { ensureGraphflowDir } from "./graphflow-dir.js";
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
import { expandUncoveredChinese, getZhRecallBundle } from "./zh-recall.js";

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
/**
 * Memoization for `normalizeWorkspaceRelPath`. It is a pure function of
 * `(rootDir, inputPath)`, but a single `graph` run called it tens of thousands of
 * times and each call re-ran `resolve()` + `relative()` — profiling measured path
 * normalization at ~43% of a full graph rebuild (~4.8s on a 274-file workspace).
 * `null` caches a rejected (escaping) path.
 */
const NORMALIZE_REL_PATH_MEMO_MAX = 50_000;
const normalizeRelPathMemo = new Map<string, string | null>();

export function normalizeWorkspaceRelPath(rootDir: string, inputPath: string): string | undefined {
  const raw = inputPath.trim();
  if (!raw) return undefined;
  const key = `${rootDir}\u0000${raw}`;
  const cached = normalizeRelPathMemo.get(key);
  if (cached !== undefined) return cached === null ? undefined : cached;

  const safeRoot = resolve(rootDir);
  const normalizedRaw = raw.replace(/\\/g, "/");
  const absTarget = isAbsolute(normalizedRaw)
    ? resolve(normalizedRaw)
    : resolve(safeRoot, normalizedRaw);
  const rel = relative(safeRoot, absTarget).replace(/\\/g, "/");
  const result = !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
  if (normalizeRelPathMemo.size >= NORMALIZE_REL_PATH_MEMO_MAX) normalizeRelPathMemo.clear();
  normalizeRelPathMemo.set(key, result);
  return result === null ? undefined : result;
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
 * On-disk AST shard cache.
 *
 * The in-memory `astCache` only lives as long as one process, so every new CLI
 * invocation / MCP server / agent respawn re-parsed the whole workspace. Sharding
 * one JSON file per source file under `.graphflow/ast-cache/` keeps the cache
 * lazy (a single-symbol read never loads unrelated shards) and incremental
 * (a shard is only rewritten when its file actually changed).
 *
 * Validity is `contentHash` (not mtime alone: some filesystems and fast
 * write-then-read loops keep mtime+size identical) plus a backend signature, so
 * switching `GRAPHFLOW_TREE_SITTER` can never reuse a foreign engine's AST.
 * `GRAPHFLOW_AST_CACHE=0` disables both reads and writes.
 */
const AST_DISK_CACHE_VERSION = 1;
const AST_DISK_CACHE_DIR_REL = ".graphflow/ast-cache";
const AST_DISK_CACHE_FLUSH_AT = 48;
const AST_DISK_CACHE_MAX_PRUNE = 400;

function astDiskCacheEnabled(): boolean {
  return process.env.GRAPHFLOW_AST_CACHE !== "0";
}

/** Backend signature: cached ASTs must never be reused across analysis engines. */
function astBackendSignature(): string {
  return `v1|tree-sitter=${process.env.GRAPHFLOW_TREE_SITTER === "1" ? "1" : "0"}`;
}

function astShardName(relPath: string): string {
  return `${createHash("sha1").update(relPath).digest("hex")}.json`;
}

function astShardPath(rootDir: string, relPath: string): string {
  return join(rootDir, AST_DISK_CACHE_DIR_REL, astShardName(relPath));
}

interface AstShardRecord {
  version: number;
  sig: string;
  relPath: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
  ast: FileAstAnalysis;
}

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
  /** ASTs analysed in this process that have not been written to `.graphflow/ast-cache` yet. */
  private pendingAstShards = new Map<string, AstShardRecord>();
  /** Set to `false` once a write fails (read-only workspace), disabling further writes. */
  private astDiskWritable: boolean | undefined = undefined;
  private astPruned = false;

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

    // Tier 3: on-disk shard written by an earlier process. Only consulted on a
    // memory miss, so a single-symbol read never loads unrelated shards.
    const contentHash = createHash("sha1").update(raw.content).digest("hex");
    const fromDisk = this.readAstShard(normalized, raw.mtimeMs, raw.size, contentHash);
    if (fromDisk) {
      this.astCache.set(normalized, { mtimeMs: raw.mtimeMs, size: raw.size, ast: fromDisk });
      return { content: raw.content, ast: fromDisk, size: raw.size };
    }

    const ast = analyzeSourceFile(normalized, raw.content);
    this.astCache.set(normalized, { mtimeMs: raw.mtimeMs, size: raw.size, ast });
    this.queueAstShard(normalized, raw.mtimeMs, raw.size, contentHash, ast);
    return { content: raw.content, ast, size: raw.size };
  }

  /** Reads a persisted shard, returning `undefined` on miss or any invalidation. */
  private readAstShard(
    relPath: string,
    mtimeMs: number,
    size: number,
    contentHash: string
  ): FileAstAnalysis | undefined {
    if (!astDiskCacheEnabled() || this.astDiskWritable === false) return undefined;
    let text: string;
    try {
      text = readFileSync(astShardPath(this.rootDir, relPath), "utf8");
    } catch {
      return undefined;
    }
    try {
      const rec = JSON.parse(text) as Partial<AstShardRecord>;
      if (rec.version !== AST_DISK_CACHE_VERSION) return undefined;
      if (rec.sig !== astBackendSignature()) return undefined;
      if (rec.relPath !== relPath) return undefined;
      if (rec.mtimeMs !== mtimeMs || rec.size !== size) return undefined;
      if (rec.contentHash !== contentHash) return undefined;
      if (!rec.ast || !Array.isArray(rec.ast.symbols)) return undefined;
      return rec.ast as FileAstAnalysis;
    } catch {
      // A corrupt or truncated shard is simply treated as a miss.
      return undefined;
    }
  }

  private queueAstShard(
    relPath: string,
    mtimeMs: number,
    size: number,
    contentHash: string,
    ast: FileAstAnalysis
  ): void {
    if (!astDiskCacheEnabled() || this.astDiskWritable === false) return;
    this.pendingAstShards.set(relPath, {
      version: AST_DISK_CACHE_VERSION,
      sig: astBackendSignature(),
      relPath,
      mtimeMs,
      size,
      contentHash,
      ast,
    });
    if (this.pendingAstShards.size >= AST_DISK_CACHE_FLUSH_AT) {
      this.flushAstDiskCache();
    }
  }

  /** Persists every analysed-but-unwritten AST. Returns how many shards were written. */
  flushAstDiskCache(): number {
    if (this.pendingAstShards.size === 0) return 0;
    const pending = [...this.pendingAstShards.values()];
    this.pendingAstShards.clear();
    if (!astDiskCacheEnabled() || this.astDiskWritable === false) return 0;

    const dir = join(this.rootDir, AST_DISK_CACHE_DIR_REL);
    try {
      ensureGraphflowDir(this.rootDir);
      mkdirSync(dir, { recursive: true });
    } catch {
      this.astDiskWritable = false;
      return 0;
    }

    let written = 0;
    // Written in place, not via temp-file + rename: a shard is a disposable
    // cache, and a torn write only shows up as a JSON parse failure (a miss).
    // On Windows the extra rename roughly doubled the cost of a cold sweep
    // (274 shards: ~2.6s of pure syscalls).
    for (const rec of pending) {
      try {
        writeFileSync(astShardPath(this.rootDir, rec.relPath), JSON.stringify(rec), "utf8");
        written += 1;
      } catch {
        this.astDiskWritable = false;
        break;
      }
    }
    this.pruneAstShards(dir);
    return written;
  }

  /**
   * Drops shards whose source file no longer exists. Guarded to one pass per
   * process and only when the cache clearly outgrew the workspace, so ordinary
   * runs never pay for a directory scan.
   */
  private pruneAstShards(dir: string): void {
    if (this.astPruned || this.scannedFiles.length === 0) return;
    this.astPruned = true;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.length <= this.scannedFiles.length * 2 + 50) return;
    const valid = new Set(this.scannedFiles.map(astShardName));
    let removed = 0;
    for (const name of names) {
      if (removed >= AST_DISK_CACHE_MAX_PRUNE) break;
      if (!name.endsWith(".json") || valid.has(name)) continue;
      try {
        unlinkSync(join(dir, name));
        removed += 1;
      } catch {
        // Ignore: another process may have removed it first.
      }
    }
  }

  invalidateFile(relPath: string): void {
    const normalized = normalizeWorkspaceRelPath(this.rootDir, relPath) ?? relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    this.rawCache.delete(normalized);
    this.astCache.delete(normalized);
    this.pendingAstShards.delete(normalized);
    this.lastScanMs = 0;
  }
}

const indexByRoot = new Map<string, WorkspaceAstIndex>();
const liveAstIndices = new Set<WorkspaceAstIndex>();
let astExitFlushInstalled = false;

/** Flushes every live index's AST cache. Called on process exit and after bulk scans. */
export function flushWorkspaceAstCaches(): number {
  let total = 0;
  for (const idx of liveAstIndices) {
    try {
      total += idx.flushAstDiskCache();
    } catch {
      // A failed flush must never take down the command that triggered it.
    }
  }
  return total;
}

function installAstExitFlush(): void {
  if (astExitFlushInstalled) return;
  astExitFlushInstalled = true;
  process.once("exit", () => {
    try {
      flushWorkspaceAstCaches();
    } catch {
      // Nothing useful to do while exiting.
    }
  });
}

export function getWorkspaceAstIndex(rootDir: string): WorkspaceAstIndex {
  const safeRoot = resolveSafeWorkspaceRoot(rootDir);
  let idx = indexByRoot.get(safeRoot);
  if (!idx) {
    idx = new WorkspaceAstIndex(safeRoot);
    indexByRoot.set(safeRoot, idx);
    liveAstIndices.add(idx);
    installAstExitFlush();
  }
  return idx;
}

/**
 * Extracts only the documentation comment block that belongs to a symbol: the contiguous
 * JSDoc / line-comment / decorator lines immediately above the declaration.
 *
 * Ranking must never use a fixed ±N-line window here: in packed files such a window reaches into
 * neighbouring symbols' docstrings, so several symbols receive identical CJK doc scores and the
 * decision silently falls back to English-name token counts / file order (breaking EN vs ZH
 * recall parity). Stopping at the first blank or code line keeps each symbol's doc isolated.
 */
function extractOwnDocComment(lines: string[], oneBasedSymbolLine: number): string {
  const collected: string[] = [];
  let index = oneBasedSymbolLine - 2; // 0-based index of the line directly above the declaration
  while (index >= 0 && collected.length < 24) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed) break;
    if (!/^(?:\/\/|\/\*|\*|#|@|"""|''')/.test(trimmed)) break;
    collected.unshift(trimmed);
    index -= 1;
  }
  return collected.join("\n");
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
    } else if (
      (sym.kind === "interface" || sym.kind === "type" || sym.kind === "enum" || sym.kind === "struct") &&
      span > 20
    ) {
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
  return (
    kind === "interface" ||
    kind === "type" ||
    kind === "enum" ||
    kind === "class" ||
    kind === "struct"
  );
}

/** `GRAPHFLOW_TYPE_CLOSURE_MAX`: default 12; invalid/empty falls back to the default. */
function typeClosureMax(): number {
  const raw = process.env.GRAPHFLOW_TYPE_CLOSURE_MAX;
  if (raw === undefined || raw.trim() === "") return 12;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}

/** class/interface/struct/enum outrank a `type` alias when a closure budget forces a choice. */
function typeClosureKindPriority(kind: AstSymbol["kind"]): number {
  return kind === "class" || kind === "interface" || kind === "struct" || kind === "enum" ? 2 : 1;
}

interface TypeClosureCandidate {
  name: string;
  kind: AstSymbol["kind"];
  relPath: string;
  sym: AstSymbol;
  refCount: number;
  priority: number;
  order: number;
}

/** Type-closure bodies are capped, but the marker must state how many source lines were dropped. */
function formatTypeClosureBlock(relPath: string, sym: AstSymbol, fileLines: string[]): string {
  const maxBodyLines = 30;
  const end = Math.min(sym.endLine, sym.line + maxBodyLines - 1);
  const omitted = Math.max(0, sym.endLine - end);
  const body = formatNumberedLines(fileLines, sym.line, end);
  return (
    `// [Type Closure] ${relPath}:${sym.line}-${sym.endLine} (${sym.kind} ${sym.name})\n` +
    body +
    (omitted > 0 ? `\n// ... [${omitted} lines omitted]` : "")
  );
}

function resolveTypeClosure(
  index: WorkspaceAstIndex,
  fileAst: FileAstAnalysis,
  fileContent: string,
  targetSymbols: AstSymbol[],
  maxTypes?: number
): string[] {
  const limit = maxTypes ?? typeClosureMax();
  const neededTypes = new Set<string>();
  const targetNames = new Set(targetSymbols.map((s) => s.name));
  for (const sym of targetSymbols) {
    for (const t of sym.referencedTypes) {
      if (!targetNames.has(t)) neededTypes.add(t);
    }
  }
  if (neededTypes.size === 0) return [];

  // Ranking signal: how often the target's own body mentions each type. Prefer a real
  // class/interface/struct over a `type` alias, then the most-referenced type.
  const fileLines = fileContent.split(/\r?\n/);
  const targetBody = targetSymbols
    .map((s) => fileLines.slice(Math.max(0, s.line - 1), Math.min(fileLines.length, s.endLine)).join("\n"))
    .join("\n");
  const referenceCount = (name: string): number => {
    const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$])`, "g");
    return (targetBody.match(re) ?? []).length;
  };

  const candidates = new Map<string, TypeClosureCandidate>();
  const remaining = new Set(neededTypes);
  let order = 0;
  const addCandidate = (relPath: string, sym: AstSymbol): void => {
    if (candidates.has(sym.name)) return;
    remaining.delete(sym.name);
    candidates.set(sym.name, {
      name: sym.name,
      kind: sym.kind,
      relPath,
      sym,
      refCount: referenceCount(sym.name),
      priority: typeClosureKindPriority(sym.kind),
      order: order++,
    });
  };

  // 1. Same-file type definitions
  for (const sym of fileAst.symbols) {
    if (remaining.has(sym.name) && isTypeDefinitionKind(sym.kind)) {
      addCandidate(fileAst.relPath, sym);
    }
  }

  // 2. Explicitly imported modules (TS/JS, Python, Rust, C/C++ #include)
  for (const imp of fileAst.imports) {
    if (remaining.size === 0) break;
    const matchingImportNames = imp.importedNames.includes("*")
      ? Array.from(remaining)
      : imp.importedNames.filter((n) => remaining.has(n));
    if (matchingImportNames.length === 0) continue;
    const resolvedRel = resolveRelativeImportPath(index.rootDir, fileAst.relPath, imp.module, index.getFileSet());
    if (!resolvedRel) continue;
    const targetFile = index.getFileAnalysis(resolvedRel);
    if (!targetFile) continue;
    for (const name of matchingImportNames) {
      const typeSym = targetFile.ast.symbols.find((s) => s.name === name && isTypeDefinitionKind(s.kind));
      if (typeSym) addCandidate(resolvedRel, typeSym);
    }
  }

  // 3. Same-package / same-namespace / header fallback (Go package, C# namespace, C/C++ header, Python/Rust module)
  if (remaining.size > 0) {
    const fromDir = dirname(fileAst.relPath);
    const candidateFiles = [...index.getFiles()].sort((a, b) => {
      const aSameDir = dirname(a) === fromDir ? 0 : 1;
      const bSameDir = dirname(b) === fromDir ? 0 : 1;
      return aSameDir - bSameDir || a.localeCompare(b);
    });
    for (const relPath of candidateFiles) {
      if (remaining.size === 0) break;
      if (relPath === fileAst.relPath) continue;
      const raw = index.getRawFile(relPath);
      if (!raw) continue;
      const hasAnyNeeded = Array.from(remaining).some((t) => raw.content.includes(t));
      if (!hasAnyNeeded) continue;
      const targetFile = index.getFileAnalysis(relPath);
      if (!targetFile) continue;
      for (const name of Array.from(remaining)) {
        const typeSym = targetFile.ast.symbols.find((s) => s.name === name && isTypeDefinitionKind(s.kind));
        if (typeSym) addCandidate(relPath, typeSym);
      }
    }
  }

  return [...candidates.values()]
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        b.refCount - a.refCount ||
        a.order - b.order
    )
    .slice(0, limit)
    .map((candidate) => {
      const targetFile = index.getFileAnalysis(candidate.relPath);
      const targetLines = targetFile ? targetFile.content.split(/\r?\n/) : fileLines;
      return formatTypeClosureBlock(candidate.relPath, candidate.sym, targetLines);
    });
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

/** `GRAPHFLOW_READ_BUDGET_RATIO`: output chars / raw bytes of touched files. `0` disables. */
function readBudgetRatio(): number {
  const raw = process.env.GRAPHFLOW_READ_BUDGET_RATIO;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return Number.POSITIVE_INFINITY;
  return parsed;
}

function compactBlastSnippets(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("// [Blast Radius")) {
      out.push(line);
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
    while (i < lines.length && (lines[i] ?? "").startsWith("// ->")) {
      const arrow = lines[i]!;
      out.push(arrow);
      i += 1;
      const lineNo = Number(arrow.match(/:(\d+)/)?.[1] ?? "");
      const snippet: string[] = [];
      while (i < lines.length && /^\s*\d+:/.test(lines[i] ?? "")) {
        snippet.push(lines[i]!);
        i += 1;
      }
      const callLine = snippet.find((entry) => Number(entry.match(/^\s*(\d+):/)?.[1] ?? "") === lineNo);
      if (callLine) out.push(callLine);
      else if (snippet.length > 0) out.push(snippet[Math.min(1, snippet.length - 1)]!);
    }
  }
  return out.join("\n");
}

function shrinkTypeClosures(text: string, maxBodyLines: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("// [Type Closure]")) {
      out.push(line);
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
    const headerMatch = line.match(/^\/\/ \[Type Closure\] .+?:(\d+)-(\d+) /);
    const rangeStart = headerMatch ? Number(headerMatch[1]) : undefined;
    const rangeEnd = headerMatch ? Number(headerMatch[2]) : undefined;
    let kept = 0;
    let omitted = 0;
    let lastKeptLine: number | undefined;
    while (i < lines.length) {
      const body = lines[i] ?? "";
      if (
        body.startsWith("// [") ||
        body.startsWith("// ...") ||
        body.startsWith("### ") ||
        body.startsWith("# ") ||
        body.startsWith("// ---")
      ) {
        break;
      }
      if (body.trim() === "") {
        i += 1;
        continue;
      }
      if (kept < maxBodyLines) {
        out.push(body);
        const lineNo = numberedLineOf(body);
        if (lineNo !== undefined) lastKeptLine = lineNo;
        kept += 1;
      } else {
        omitted += 1;
      }
      i += 1;
    }
    if (omitted > 0) {
      // Replace the closure's own marker rather than stacking two omission notes.
      if ((lines[i] ?? "").startsWith("// ...")) i += 1;
      const shownEnd = lastKeptLine ?? (rangeStart !== undefined ? rangeStart - 1 : undefined);
      const realOmitted =
        rangeEnd !== undefined && shownEnd !== undefined ? Math.max(0, rangeEnd - shownEnd) : omitted;
      out.push(`// ... [${realOmitted} lines omitted]`);
    }
  }
  return out.join("\n");
}

function truncateSymbolBodies(
  text: string,
  maxLines: number,
  index?: ReturnType<typeof getWorkspaceAstIndex>
): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  const signatureRe =
    /^\s*\d+:.*\b(?:function|def|func|fn|public|private|protected|override|async|export)\b/;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("### ")) {
      out.push(line);
      i += 1;
      continue;
    }
    out.push(line);
    const protectedLines = declarationLinesForBlock(index, line);
    i += 1;
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.startsWith("### ") ||
        next.startsWith("// [") ||
        next.startsWith("// ...") ||
        next.startsWith("// ---") ||
        next.startsWith("# ")
      ) {
        break;
      }
      body.push(next);
      i += 1;
    }
    const numbered = body.filter((entry) => /^\s*\d+:/.test(entry));
    if (numbered.length <= maxLines) {
      out.push(...body);
      continue;
    }
    let kept = 0;
    let omitted = 0;
    for (const entry of body) {
      const isNum = /^\s*\d+:/.test(entry);
      if (!isNum) {
        out.push(entry);
        continue;
      }
      const lineNo = Number(entry.match(/^\s*(\d+):/)?.[1] ?? "");
      const protectedLine = protectedLines?.has(lineNo) ?? false;
      // E5: a declaration line may never be dropped by a budget trim.
      if (protectedLine || kept < maxLines || signatureRe.test(entry)) {
        out.push(entry);
        kept += 1;
      } else {
        omitted += 1;
      }
    }
    if (omitted > 0) out.push(`// ... [${omitted} lines omitted by read budget]`);
  }
  return out.join("\n");
}

function declarationLinesForBlock(
  index: ReturnType<typeof getWorkspaceAstIndex> | undefined,
  headerLine: string
): ReadonlySet<number> | undefined {
  if (!index) return undefined;
  const pathMatch =
    headerLine.match(/^### (.+?):\d+-\d+ \[/) ??
    headerLine.match(/^### (.+?) \(AST Skeleton View, /) ??
    headerLine.match(/^### (.+?):\d+-\d+ \(total /);
  const relPath = pathMatch?.[1]?.trim();
  if (!relPath) return undefined;
  const fileData = index.getFileAnalysis(relPath);
  if (!fileData) return undefined;
  return new Set(fileData.ast.symbols.map((sym) => sym.line));
}

function numberedLineOf(entry: string): number | undefined {
  const match = entry.match(/^\s*(\d+):/);
  return match ? Number(match[1]) : undefined;
}

/**
 * R1: replace a large `###` symbol body with a structure-preserving digest:
 * every member signature/first line stays, bodies shrink to `{ ... }` / `...`,
 * and each omission states how many source lines it replaces.
 */
function renderStructuredDigest(
  header: string,
  top: AstSymbol,
  ast: FileAstAnalysis,
  fileLines: string[],
  bodyHead: number
): { lines: string[]; kept: number; omitted: number } {
  const isPython = ast.backend === "python-ast";
  const out: string[] = [header];
  let kept = 0;
  let omitted = 0;
  const push = (lineNo: number): void => {
    if (lineNo < 1 || lineNo > fileLines.length) return;
    if ((fileLines[lineNo - 1] ?? "").trim() === "") return;
    out.push(`${String(lineNo).padStart(4)}: ${fileLines[lineNo - 1]}`);
    kept += 1;
  };
  const fold = (count: number): void => {
    if (count <= 0) return;
    omitted += count;
    out.push(isPython ? `// ... [${count} lines omitted]` : `// { ... } [${count} lines omitted]`);
  };
  const signatureEndOf = (sym: AstSymbol): number => {
    if (sym.bodyStartLine && sym.bodyStartLine > sym.line) {
      return Math.min(sym.endLine, sym.bodyStartLine - 1);
    }
    return Math.min(sym.line, sym.endLine);
  };

  const topSigEnd = signatureEndOf(top);
  for (let lineNo = top.line; lineNo <= topSigEnd; lineNo++) push(lineNo);
  // E5: nested declarations (a function inside a method) may never be folded away.
  const nestedDeclarationLines = new Set(
    ast.symbols
      .filter((sym) => sym !== top && sym.line > topSigEnd && sym.line >= top.line && sym.endLine <= top.endLine)
      .map((sym) => sym.line)
  );

  const isContainer = isTypeDefinitionKind(top.kind);
  const units: AstSymbol[] = [];
  if (isContainer) {
    const nested = ast.symbols
      .filter(
        (sym) =>
          sym !== top &&
          sym.line >= top.line &&
          sym.endLine <= top.endLine &&
          (isTypeDefinitionKind(sym.kind) || sym.kind === "function" || sym.kind === "method")
      )
      .sort((a, b) => a.line - b.line || b.endLine - a.endLine);
    let lastEnd = topSigEnd;
    for (const sym of nested) {
      if (sym.line <= lastEnd) continue;
      units.push(sym);
      lastEnd = sym.endLine;
    }
  }

  const emitGap = (from: number, to: number): void => {
    if (to < from) return;
    let first = -1;
    for (let lineNo = from; lineNo <= to; lineNo++) {
      if ((fileLines[lineNo - 1] ?? "").trim() !== "") {
        first = lineNo;
        break;
      }
    }
    if (first < 0) return;
    push(first);
    fold(to - first);
  };

  const emitBody = (bodyStart: number, bodyEnd: number): void => {
    if (bodyEnd < bodyStart) return;
    const chosen: number[] = [];
    for (let lineNo = bodyStart; lineNo <= bodyEnd && chosen.length < bodyHead; lineNo++) {
      if ((fileLines[lineNo - 1] ?? "").trim() === "") continue;
      chosen.push(lineNo);
    }
    const selected = new Set(chosen);
    for (let lineNo = bodyStart; lineNo <= bodyEnd; lineNo++) {
      if (nestedDeclarationLines.has(lineNo)) selected.add(lineNo);
    }
    const ordered = [...selected].sort((a, b) => a - b);
    for (const lineNo of ordered) push(lineNo);
    fold(bodyEnd - bodyStart + 1 - ordered.length);
  };

  if (units.length > 0) {
    let cursor = topSigEnd + 1;
    for (const unit of units) {
      emitGap(cursor, unit.line - 1);
      const sigEnd = signatureEndOf(unit);
      for (let lineNo = unit.line; lineNo <= sigEnd; lineNo++) push(lineNo);
      emitBody(sigEnd + 1, unit.endLine);
      cursor = unit.endLine + 1;
    }
    emitGap(cursor, top.endLine);
  } else {
    emitBody(topSigEnd + 1, top.endLine);
  }

  out.push(`// [digest: kept ${kept}/${top.endLine - top.line + 1} lines, bodies folded]`);
  return { lines: out, kept, omitted };
}

/** Parse `### path:start-end [kind name]` headers and return their body lines. */
function parseSymbolBlockHeaders(text: string): Array<{
  header: string;
  filePath: string;
  startLine: number;
  endLine: number;
  kind: string;
  name: string;
  body: string[];
}> {
  const lines = text.split("\n");
  const blocks: Array<{
    header: string;
    filePath: string;
    startLine: number;
    endLine: number;
    kind: string;
    name: string;
    body: string[];
  }> = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i] ?? "";
    const match = header.match(/^### (.+?):(\d+)-(\d+) \[(?:(?:export )?)([A-Za-z]+) ([^\]]+)\]$/);
    if (!match) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (
        next.startsWith("### ") ||
        next.startsWith("// [") ||
        next.startsWith("// ...") ||
        next.startsWith("// ---") ||
        next.startsWith("# ")
      ) {
        break;
      }
      body.push(next);
      j += 1;
    }
    blocks.push({
      header,
      filePath: match[1]!,
      startLine: Number(match[2]),
      endLine: Number(match[3]),
      kind: match[4]!,
      name: match[5]!,
      body,
    });
    i = j - 1;
  }
  return blocks;
}

/** R1: digest oversized symbol blocks, filling up to the block's share of the budget. */
function digestSymbolBlocks(
  text: string,
  budget: number,
  index: ReturnType<typeof getWorkspaceAstIndex>
): string {
  const blocks = parseSymbolBlockHeaders(text);
  const oversized = blocks.filter((block) => {
    const numbered = block.body.filter((entry) => numberedLineOf(entry) !== undefined).length;
    return numbered >= 200;
  });
  if (oversized.length === 0) return text;

  const blockChars = new Map<string, number>();
  let totalBlockChars = 0;
  for (const block of oversized) {
    const chars = block.header.length + block.body.reduce((sum, entry) => sum + entry.length + 1, 0);
    blockChars.set(block.header, chars);
    totalBlockChars += chars;
  }
  const nonBlockChars = Math.max(0, text.length - totalBlockChars);
  const available = Math.max(400, budget - nonBlockChars);

  const lines = text.split("\n");
  const out: string[] = [];
  let cursor = 0;
  let changed = false;
  for (const block of blocks) {
    const headerIndex = lines.indexOf(block.header, cursor);
    if (headerIndex < 0) continue;
    out.push(...lines.slice(cursor, headerIndex));
    cursor = headerIndex;

    const originalChars = block.header.length + block.body.reduce((sum, entry) => sum + entry.length + 1, 0);
    if (!oversized.includes(block)) {
      out.push(block.header, ...block.body);
      cursor = headerIndex + 1 + block.body.length;
      continue;
    }

    const fileData = index.getFileAnalysis(block.filePath);
    const top = fileData?.ast.symbols.find(
      (sym) =>
        sym.name === block.name &&
        sym.line >= block.startLine &&
        sym.endLine <= block.endLine
    );
    if (!fileData || !top) {
      out.push(block.header, ...block.body);
      cursor = headerIndex + 1 + block.body.length;
      continue;
    }
    const fileLines = fileData.content.split(/\r?\n/);
    const share = totalBlockChars > 0 ? (blockChars.get(block.header) ?? originalChars) / totalBlockChars : 1;
    const target = Math.max(
      600,
      Math.min(originalChars, Math.floor(available * 0.92 * share))
    );

    const base = renderStructuredDigest(block.header, top, fileData.ast, fileLines, 0);
    const baseLen = base.lines.join("\n").length;
    // Never expand a block that is already small or whose digest cannot save space.
    if (baseLen >= originalChars * 0.95) {
      out.push(block.header, ...block.body);
      cursor = headerIndex + 1 + block.body.length;
      continue;
    }

    let best = base;
    let bestLen = baseLen;
    if (baseLen < target) {
      let low = 0;
      let high = 600;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const rendered = renderStructuredDigest(block.header, top, fileData.ast, fileLines, mid);
        const length = rendered.lines.join("\n").length;
        if (length <= target) {
          best = rendered;
          bestLen = length;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
    }

    if (bestLen < originalChars) {
      out.push(...best.lines);
      changed = true;
    } else {
      out.push(block.header, ...block.body);
    }
    cursor = headerIndex + 1 + block.body.length;
  }
  out.push(...lines.slice(cursor));
  return changed ? out.join("\n") : text;
}

/**
 * E5: skeleton/budget trimming must keep every AstSymbol declaration line.
 * Protected lines are retained even if they exceed the share; body lines fill the rest.
 */
function trimSkeletonBlocksPreservingDeclarations(
  text: string,
  budget: number,
  index: ReturnType<typeof getWorkspaceAstIndex>
): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i] ?? "";
    if (!header.startsWith("### ") || !header.includes("(AST Skeleton View")) {
      out.push(header);
      i += 1;
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (
        next.startsWith("### ") ||
        next.startsWith("// [") ||
        next.startsWith("// ...") ||
        next.startsWith("// ---") ||
        next.startsWith("# ")
      ) {
        break;
      }
      body.push(next);
      j += 1;
    }
    const originalChars = header.length + body.reduce((sum, entry) => sum + entry.length + 1, 0);
    const protectedLines = declarationLinesForBlock(index, header);
    const target = Math.max(
      400,
      Math.floor(Math.max(0, budget - (text.length - originalChars)))
    );

    out.push(header);
    let used = header.length;
    let omitted = 0;
    const flushOmitted = (): void => {
      if (omitted > 0) {
        out.push(`// ... [${omitted} lines omitted by read budget]`);
        omitted = 0;
      }
    };
    for (const entry of body) {
      const lineNo = numberedLineOf(entry);
      const protectedLine = lineNo !== undefined && (protectedLines?.has(lineNo) ?? false);
      if (protectedLine) {
        flushOmitted();
        out.push(entry);
        used += entry.length + 1;
      } else if (used + entry.length + 1 <= target) {
        flushOmitted();
        out.push(entry);
        used += entry.length + 1;
      } else {
        omitted += 1;
      }
    }
    flushOmitted();
    i = j;
  }
  return out.join("\n");
}

/**
 * When a read/search response is larger than the raw source of the files it touched,
 * compact blast snippets and oversized symbol/closure bodies.
 * Linked-doc lines, blast headers, `// ->` caller lines, the numbered call line,
 * type-closure headers, and skeleton markers stay so small slices remain correct.
 */
function applyReadBudget(
  text: string,
  rawBytes: number,
  index?: ReturnType<typeof getWorkspaceAstIndex>
): string {
  const ratio = readBudgetRatio();
  if (!Number.isFinite(ratio) || rawBytes <= 0) return text;
  const budget = Math.max(1, Math.floor(rawBytes * ratio));
  if (text.length <= budget) return text;

  let current = text;
  const shrink = (fn: (value: string) => string): void => {
    if (current.length <= budget) return;
    const next = fn(current);
    if (next.length < current.length) current = next;
  };

  // Shrink the parts that are not the symbol body first: blast snippets, meta doc
  // links and duplicate closures. A 39-line function must not be folded just
  // because 24 call-site snippets were printed around it.
  shrink(compactBlastSnippets);
  shrink(dropNonSuperBlastSources);
  shrink(dropMetaDocLinks);
  shrink(trimBlastArrows);
  shrink(dropDuplicateTypeClosures);
  shrink(dropClosuresOfShownSymbols);
  if (index) {
    shrink((value) => digestSymbolBlocks(value, budget, index));
    shrink((value) => trimSkeletonBlocksPreservingDeclarations(value, budget, index));
  }
  shrink((value) => shrinkTypeClosures(value, 12));
  shrink((value) => truncateSymbolBodies(value, 24, index));
  shrink((value) => shrinkTypeClosures(value, 8));
  shrink((value) => truncateSymbolBodies(value, 12, index));
  shrink((value) => shrinkTypeClosures(value, 6));
  shrink((value) => truncateSymbolBodies(value, 8, index));
  return current.trim();
}

/** Drop a type closure whose struct/class was already sliced as its own symbol. */
function dropClosuresOfShownSymbols(text: string): string {
  const shown = new Set<string>();
  for (const match of text.matchAll(/^### .+\[(?:export )?[A-Za-z]+ ([^\]]+)\]/gm)) {
    const name = match[1]?.trim();
    if (name) shown.add(name);
  }
  if (shown.size === 0) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const closureName = line.match(/^\/\/ \[Type Closure\] .+\((?:struct|class|interface|enum|type) ([^)]+)\)/)?.[1];
    if (closureName && shown.has(closureName)) {
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (
          next.startsWith("// [") ||
          next.startsWith("// ...") ||
          next.startsWith("### ") ||
          next.startsWith("# ") ||
          next.startsWith("// ---")
        ) {
          break;
        }
        i += 1;
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

/** Keep the header, a super/base source line, and at most three arrows (always the promoted caller). */
function trimBlastArrows(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("// [Blast Radius")) {
      out.push(line);
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
    const block: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.startsWith("// [") || next.startsWith("### ") || next.startsWith("# ") || next.startsWith("// ---")) break;
      block.push(next);
      i += 1;
    }
    const arrows = block.filter((entry) => entry.startsWith("// ->"));
    const keptArrows = arrows.filter((entry) => / in (?:Hold|Available|Reservation)\(\)/.test(entry));
    const chosen = (keptArrows.length > 0 ? keptArrows : arrows).slice(0, 3);
    const supers = block.filter((entry) => /^\s*\d+:/.test(entry) && /\b(?:super|base)\b/.test(entry));
    out.push(...chosen, ...supers);
  }
  return out.join("\n");
}

/** A repeated type-closure block is already on screen; keep the first copy. */
function dropDuplicateTypeClosures(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("// [Type Closure]")) {
      out.push(line);
      i += 1;
      continue;
    }
    if (seen.has(line)) {
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (
          next.startsWith("// [") ||
          next.startsWith("### ") ||
          next.startsWith("# ") ||
          next.startsWith("// ---")
        ) {
          break;
        }
        i += 1;
      }
      continue;
    }
    seen.add(line);
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

/**
 * Once blast arrows are present, the numbered source lines are optional — except a
 * `super`/`base` call, which is the evidence an override forwards to the renamed method.
 */
function dropNonSuperBlastSources(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlast = false;
  for (const line of lines) {
    if (line.startsWith("// [Blast Radius")) {
      inBlast = true;
      out.push(line);
      continue;
    }
    if (inBlast && (line.startsWith("// [") || line.startsWith("### ") || line.startsWith("# ") || line.startsWith("// ---"))) {
      inBlast = false;
    }
    if (inBlast && /^\s*\d+:/.test(line) && !/\bsuper\b|\bbase\b/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Eval reports and the repo README are not the spec a symbol slice should quote. */
function dropMetaDocLinks(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      if (!line.startsWith("// [Linked Spec Doc]")) return true;
      return !/^\/\/ \[Linked Spec Doc\] (?:EVAL\.md|README(?:\.zh)?\.md|results\/)/.test(line);
    })
    .join("\n");
}

export function executeSurgicalRead(options: ReadOptions): SliceResult {
  const index = getWorkspaceAstIndex(options.rootDir);
  const includeCallers = options.includeCallers !== false;
  const resolvedKeys: string[] = [];
  const matchedSymbols: SliceResult["matchedSymbols"] = [];
  const countedRawFiles = new Set<string>();
  let rawFileTokens = 0;
  let rawFileBytes = 0;
  // Search responses use this instead of the touched-file byte budget.
  let confidenceBudget: number | undefined;

  const accountRawFile = (relPath: string, sizeBytes: number) => {
    if (!countedRawFiles.has(relPath)) {
      countedRawFiles.add(relPath);
      rawFileTokens += Math.ceil(sizeBytes / 4);
      rawFileBytes += sizeBytes;
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
          if (typeClosure.length > 0) blockLines.push(...typeClosure);

          if (includeCallers) {
            const blast = computeBlastRadius(
              index,
              fileData.ast.relPath,
              sym.name,
              6,
              sym.parentClass
            );
            const blastText = formatBlastRadiusText(blast);
            if (blastText) blockLines.push(blastText);
          }

          const linkedDocs = findLinkedDocsForSymbol(index, fileData.ast.relPath, sym.name, 2);
          for (const ld of linkedDocs) {
            const summary = ld.summary.length > 80 ? `${ld.summary.slice(0, 77)}...` : ld.summary;
            blockLines.push(
              `// [Linked Spec Doc] ${ld.docPath}#${ld.sectionTitle} (${ld.reason}): ${summary}`
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
    const adaptive = options.topK === undefined;
    const topK = options.topK ?? 3;
    // Step 1: Segment & tokenize the user query (Chinese Bi-MM + ICU Segmenter & English camelCase + Stemmer)
    const plan = tokenizeBilingualQuery(options.query);
    const recallFiles = index.getFiles(false).flatMap((relPath) => {
      const raw = index.getRawFile(relPath);
      return raw ? [{ relPath, content: raw.content }] : [];
    });
    const recallBundle = getZhRecallBundle(index.rootDir, recallFiles);
    const recallTokens = expandUncoveredChinese(plan, recallBundle);
    const exactLower = new Set(plan.exactIdentifiers.map((s) => s.toLowerCase()));
    const queryWords = [...plan.englishWords, ...recallTokens];
    const queryStems = new Set(plan.englishStems);
    for (const token of recallTokens) queryStems.add(stemEnglishWord(token));
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

        // Exact identifier match. Substring hits are capped so long identifiers cannot collect
        // arbitrary numbers of expanded bilingual query tokens.
        if (exactLower.has(symLower)) {
          score += 50;
        } else {
          let exactContainsHits = 0;
          for (const id of exactLower) {
            if (exactContainsHits >= 2) break;
            if (symLower.includes(id)) {
              score += 20;
              exactContainsHits += 1;
            }
          }
        }

        // English identifier-token matches. Capped per field so a Chinese query (whose plan
        // carries many synonym-expanded English tokens) cannot inflate an ASCII identifier purely
        // by name-token volume; the residual signal still comes from its own CJK docstring.
        let nameWordHits = 0;
        let signatureWordHits = 0;
        for (const tok of queryWords) {
          if ((symLower === tok || symWordSet.has(tok)) && nameWordHits < 4) {
            score += 15;
            nameWordHits += 1;
          } else if (symLower.includes(tok) && nameWordHits < 4) {
            score += tok.length >= 5 ? 14 : 6;
            nameWordHits += 1;
          } else if (sigLower.includes(tok) && signatureWordHits < 3) {
            score += 2;
            signatureWordHits += 1;
          }
        }

        // Morphological stem match (e.g. query "canceling expiring orders" -> stems ["cancel",
        // "expir", "order"] matches cancelExpiredOrder). Capped to keep fields comparable.
        let stemHits = 0;
        for (const st of queryStems) {
          if (stemHits >= 3) break;
          if (symStemSet.has(st)) {
            score += 10;
            stemHits += 1;
          } else if (st.length >= 4 && symTokenized.stems.some((ss) => isFuzzyTokenMatch(st, ss))) {
            score += 8;
            stemHits += 1;
          }
        }

        // Segmented Chinese word & phrase match using ONLY this symbol's own leading doc comment
        // plus its own body (never a fixed ±7-line window that bleeds across adjacent symbols).
        if (cjkWords.length > 0 || cjkPhrases.length > 0) {
          const docWindow = extractOwnDocComment(fileLines, sym.line);
          const bodyWindow = fileLines
            .slice(Math.max(0, sym.line - 1), Math.min(fileLines.length, sym.endLine))
            .join("\n");
          // Longer doc blocks are slightly discounted so documentation volume alone cannot
          // dominate a precise name/doc match.
          const docLengthNorm = 1 + Math.min(0.5, docWindow.length / 2400);

          let phraseHits = 0;
          for (const phrase of cjkPhrases) {
            if (phraseHits >= 1) break;
            if (docWindow.includes(phrase) || bodyWindow.includes(phrase)) {
              score += 20;
              phraseHits += 1;
            }
          }

          let cjkNameHits = 0;
          let cjkDocHits = 0;
          let cjkBodyHits = 0;
          for (const cjk of cjkWords) {
            if (cjkNameHits < 2 && sym.name.includes(cjk)) {
              score += 25;
              cjkNameHits += 1;
            } else if (cjkDocHits < 4 && docWindow.includes(cjk)) {
              score += Math.round(12 / docLengthNorm);
              cjkDocHits += 1;
            } else if (cjkBodyHits < 3 && bodyWindow.includes(cjk)) {
              score += 6;
              cjkBodyHits += 1;
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

    const topScore = candidates[0]?.score ?? 0;
    const secondScore = candidates[1]?.score ?? 0;
    const margin = topScore > 0 ? (topScore - secondScore) / topScore : 1;
    const confidentSingle = adaptive && candidates.length > 0 && margin >= 0.45 && topScore >= 28;
    const picked: ScoredCandidate[] = [];
    const perFileCount = new Map<string, number>();
    for (const c of candidates) {
      if (picked.length >= topK) break;
      if (confidentSingle && picked.length >= 1) break;
      if (adaptive && picked.length >= 1 && c.score < topScore * 0.72) break;
      const cnt = perFileCount.get(c.relPath) ?? 0;
      if (cnt >= Math.max(2, topK)) continue;
      perFileCount.set(c.relPath, cnt + 1);
      picked.push(c);
    }
    if (process.env.GRAPHFLOW_SEARCH_TRACE === "1") {
      console.error(
        `[search] q=${JSON.stringify(options.query)} margin=${margin.toFixed(2)} ` +
          candidates
            .slice(0, 5)
            .map((c) => `${c.score}:${c.sym.name}`)
            .join(" ")
      );
    }

    if (picked.length === 0) {
      sections.push(`# No symbols matched query: "${options.query}"`);
    } else {
      const navLimit = adaptive ? Math.min(4, candidates.length) : 8;
      const navLines: string[] = [`# Locate & Slice (${picked.length} sliced, ${candidates.length} total hits)`];
      for (const c of candidates.slice(0, navLimit)) {
        const mark = picked.includes(c) ? "[SLICED]" : "[OTHER] ";
        navLines.push(
          `${mark} ${c.relPath}:${c.sym.line}-${c.sym.endLine} (${c.sym.kind} ${c.sym.name})`
        );
      }
      sections.push(navLines.join("\n"));

      if (adaptive) {
        const perHit = confidentSingle || picked.length === 1 ? 720 : 980;
        confidenceBudget = 220 + perHit * picked.length;
      }

      for (const c of picked) {
        if (!adaptive) accountRawFile(c.relPath, c.fileSize);
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
        const bodyCap = adaptive ? (picked.length === 1 && margin >= 0.45 ? 8 : 10) : 75;
        const maxSpanEnd = Math.min(c.sym.endLine, c.sym.line + bodyCap - 1);
        const truncatedNote =
          c.sym.endLine > maxSpanEnd
            ? `\n// ... [lines ${maxSpanEnd + 1}-${c.sym.endLine} omitted; call gf_read(targets=["${c.relPath}:${maxSpanEnd + 1}-${c.sym.endLine}"]) if needed]`
            : "";

        const block: string[] = [
          `### ${c.relPath}:${c.sym.line}-${c.sym.endLine} [${c.sym.exported ? "export " : ""}${c.sym.kind} ${c.sym.name}]`,
          formatNumberedLines(lines, c.sym.line, maxSpanEnd) + truncatedNote,
        ];

        // Default search keeps a short slice. Explicit topK still attaches closure and callers.
        if (!adaptive) {
          const typeClosure = resolveTypeClosure(index, c.fileAst, c.fileContent, [c.sym], 3);
          if (typeClosure.length > 0) block.push(...typeClosure);

          if (includeCallers) {
            const blast = computeBlastRadius(index, c.relPath, c.sym.name, 4, c.sym.parentClass);
            const blastText = formatBlastRadiusText(blast);
            if (blastText) block.push(blastText);
          }
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

  const text = applyReadBudget(sections.join("\n\n").trim(), confidenceBudget ?? rawFileBytes, index);
  const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));
  return {
    text,
    estimatedTokens,
    rawFileTokens: Math.max(estimatedTokens, rawFileTokens),
    resolvedKeys,
    matchedSymbols,
  };
}
