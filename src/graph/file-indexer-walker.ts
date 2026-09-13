/**
 * file-indexer-walker.ts — File traversal and filtering
 *
 * Responsible for discovering scannable files in a workspace,
 * applying extension filters, and respecting ignore lists.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ALL_LANGUAGE_EXTENSIONS } from "./language-indexers/index.js";
import {
  DEFAULT_DOCUMENT_MAX_FILE_SIZE,
  isOfficeDocumentPath,
  OFFICE_DOCUMENT_EXTENSIONS,
} from "./document-convert.js";
import { safeReaddirSync, safeStatSync } from "../utils/safe-fs.js";

import type { EmbeddingProvider } from "../learning/embeddings.js";

export interface FileIndexerOptions {
  includeExtensions?: string[];
  maxFileSizeBytes?: number;
  /** When true, ignore index cache and re-process every file. */
  forceReindex?: boolean;
  /** 并行索引文件时的并发数，默认 10。仅 indexWorkspaceFiles 使用。 */
  concurrency?: number;
  /** Optional embedding provider for attaching vector embeddings to nodes. */
  embeddingProvider?: EmbeddingProvider;
  /** Optional per-batch progress callback, invoked with files processed so far and total scanned files. */
  onProgress?: (processed: number, total: number) => void;
  /**
   * Skip files that git ignores (exact semantics via `git ls-files
   * --exclude-standard`), so a large monorepo does not index build output,
   * generated clients, vendored copies and local scratch dirs. Default true;
   * ignored when the workspace is not a git checkout or git is unavailable.
   */
  respectGitIgnore?: boolean;
  /**
   * Skip reference edges for names defined in more than this many files
   * (document-frequency pruning; 0 = no limit). Default
   * DEFAULT_REFERENCE_MAX_DEFINITION_FILES.
   */
  referenceEdgeMaxDefinitionFiles?: number;
  /**
   * Cap reference edges emitted per source file (0 = no limit). Default
   * DEFAULT_REFERENCE_MAX_EDGES_PER_FILE.
   */
  referenceEdgeMaxPerFile?: number;
  /**
   * Worker threads used for per-file parsing. `0` disables the pool (in-process
   * parsing), a positive number pins the count, `undefined` picks a default from
   * the machine's cores. `GRAPHFLOW_INDEX_WORKERS=0` disables it globally.
   */
  indexWorkers?: number;
}

export interface ScannedFile {
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

const BASE_EXTENSIONS = [".md", ".json"];
export const DEFAULT_EXTENSIONS = Array.from(
  new Set([...ALL_LANGUAGE_EXTENSIONS, ...BASE_EXTENSIONS, ...OFFICE_DOCUMENT_EXTENSIONS])
);
export const DEFAULT_MAX_FILE_SIZE = 200_000;

export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "coverage", "tmp", "venv", ".venv", "env", ".env",
  "__pycache__", ".vscode", ".idea", ".next", "build", "install", "log",
  ".graphflow-cache", "graphflow-out",
  ".dart_tool",
  // Agent tooling dirs: `.claude/worktrees` holds full repo copies per worktree
  // and other agents keep settings/transcripts here — indexing them pollutes
  // the graph with duplicate files (observed: 76% of File nodes).
  ".agent", ".claude", ".cursor", ".gemini", ".joycode", ".trae", "Cursor",
  // Windows protected / system-heavy directories (EPERM when scanned)
  "ElevatedDiagnostics", "Application Data", "Packages", "Microsoft", "Temp", "Temporary Internet Files",
  "System Volume Information", "$Recycle.Bin",
]);

/**
 * Files that are large, machine-written and useless as graph context: lockfiles,
 * minified bundles, source maps and generated bindings. They used to be indexed
 * whenever their extension was in `includeExtensions` (e.g. `*.json` matched
 * `package-lock.json`, `*.py` matched `*_pb2.py`), which inflated both indexing
 * time and the graph store for large projects.
 */
const GENERATED_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json)$/i,
  /\.(min|bundle|chunk|umd|minified)\.(js|mjs|cjs|css)$/i,
  /-min\.(js|css)$/i,
  /\.(js|css|mjs|cjs)\.map$/i,
  /(^|\/)(.*_pb2(_grpc)?\.py|.*\.pb\.(go|cc|h)|.*\.g\.dart|.*\.freezed\.dart|.*\.designer\.cs)$/i,
  /\.generated\.[a-z0-9]+$/i,
];

/** True for lockfiles, minified bundles, source maps and generated bindings. */
export function isGeneratedOrLockFile(filePathOrName: string): boolean {
  const normalized = filePathOrName.replace(/\\/g, "/");
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Repo-relative POSIX paths git considers part of the working tree (tracked +
 * untracked, minus ignored). Returns undefined when the directory is not a git
 * checkout or git cannot be run, so callers fall back to the plain walk.
 */
export function readGitVisibleFiles(rootDir: string): Set<string> | undefined {
  if (!existsSync(join(rootDir, ".git"))) {
    return undefined;
  }
  try {
    const result = spawnSync(
      "git",
      [
        "-C",
        rootDir,
        // Never C-quote non-ASCII paths: we compare against raw filesystem paths.
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }
    );
    if (result.status !== 0 || !result.stdout) {
      return undefined;
    }
    const text = result.stdout.toString("utf8");
    const visible = new Set<string>();
    for (const entry of text.split("\u0000")) {
      if (entry) visible.add(entry);
    }
    return visible;
  } catch {
    return undefined;
  }
}

/**
 * Walk the workspace and return scannable files with metadata.
 */
export function walkScannableFiles(
  rootDir: string,
  includeExtensions: string[],
  maxFileSizeBytes: number,
  options: { respectGitIgnore?: boolean } = {}
): ScannedFile[] {
  const files = walkFiles(rootDir, includeExtensions, options);
  const scanned: ScannedFile[] = [];

  for (const absPath of files) {
    const stat = safeStatSync(absPath);
    if (!stat) {
      continue;
    }
    // Office/PDF docs often exceed source-file limits; allow a higher cap.
    const sizeLimit = isOfficeDocumentPath(absPath)
      ? Math.max(maxFileSizeBytes, DEFAULT_DOCUMENT_MAX_FILE_SIZE)
      : maxFileSizeBytes;
    if (stat.size > sizeLimit) {
      continue;
    }
    scanned.push({
      absPath,
      relPath: normalizePath(relative(rootDir, absPath)),
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
    });
  }

  return scanned;
}

/**
 * Iteratively walk directories, skipping IGNORED_DIRS, returning files
 * whose extension matches `includeExtensions`.
 * (Iterative to avoid call-stack overflow on deeply nested monorepos.)
 */
export function walkFiles(
  rootDir: string,
  includeExtensions: string[],
  options: { respectGitIgnore?: boolean } = {}
): string[] {
  const files: string[] = [];
  const dirStack: string[] = [rootDir];
  const gitVisible = options.respectGitIgnore === false ? undefined : readGitVisibleFiles(rootDir);

  while (dirStack.length > 0) {
    const current = dirStack.pop()!;
    const entries = safeReaddirSync(current);

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        // A directory holding only ignored/untracked files cannot contribute.
        if (gitVisible && !directoryMayContainVisibleFiles(rootDir, full, gitVisible)) {
          continue;
        }
        dirStack.push(full);
        continue;
      }

      if (!includeExtensions.some((ext) => entry.name.endsWith(ext))) {
        continue;
      }
      if (isGeneratedOrLockFile(entry.name)) {
        continue;
      }
      if (gitVisible && !gitVisible.has(normalizePath(relative(rootDir, full)))) {
        continue;
      }
      files.push(full);
    }
  }

  return files;
}

/** True when any git-visible path lies under `dir` (prefix scan over the set). */
function directoryMayContainVisibleFiles(
  rootDir: string,
  dir: string,
  gitVisible: Set<string>
): boolean {
  const prefix = normalizePath(relative(rootDir, dir));
  if (!prefix) {
    return true;
  }
  const withSlash = `${prefix}/`;
  for (const pathText of gitVisible) {
    if (pathText.startsWith(withSlash)) {
      return true;
    }
  }
  return false;
}

export function normalizePath(pathText: string): string {
  return pathText.replace(/\\/g, "/");
}

export function extOf(relPath: string): string {
  const idx = relPath.lastIndexOf(".");
  if (idx < 0) {
    return "";
  }
  return relPath.slice(idx).toLowerCase();
}