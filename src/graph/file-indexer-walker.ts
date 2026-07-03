/**
 * file-indexer-walker.ts — File traversal and filtering
 *
 * Responsible for discovering scannable files in a workspace,
 * applying extension filters, and respecting ignore lists.
 */

import { join, relative } from "node:path";
import { ALL_LANGUAGE_EXTENSIONS } from "./language-indexers/index.js";
import { safeReaddirSync, safeStatSync } from "../utils/safe-fs.js";

export interface FileIndexerOptions {
  includeExtensions?: string[];
  maxFileSizeBytes?: number;
  /** When true, ignore index cache and re-process every file. */
  forceReindex?: boolean;
  /** 并行索引文件时的并发数，默认 10。仅 indexWorkspaceFiles 使用。 */
  concurrency?: number;
}

export interface ScannedFile {
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

const BASE_EXTENSIONS = [".md", ".json"];
export const DEFAULT_EXTENSIONS = Array.from(
  new Set([...ALL_LANGUAGE_EXTENSIONS, ...BASE_EXTENSIONS])
);
export const DEFAULT_MAX_FILE_SIZE = 200_000;

export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "coverage", "tmp", "venv", ".venv", "env", ".env",
  "__pycache__", ".vscode", ".idea", ".next", "build", "install", "log",
  ".graphflow-cache", "graphflow-out",
  // Windows protected / system-heavy directories (EPERM when scanned)
  "ElevatedDiagnostics", "Application Data", "Packages", "Microsoft", "Temp", "Temporary Internet Files",
  "System Volume Information", "$Recycle.Bin",
]);

/**
 * Walk the workspace and return scannable files with metadata.
 */
export function walkScannableFiles(
  rootDir: string,
  includeExtensions: string[],
  maxFileSizeBytes: number
): ScannedFile[] {
  const files = walkFiles(rootDir, includeExtensions);
  const scanned: ScannedFile[] = [];

  for (const absPath of files) {
    const stat = safeStatSync(absPath);
    if (!stat || stat.size > maxFileSizeBytes) {
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
 * Recursively walk directories, skipping IGNORED_DIRS, returning files
 * whose extension matches `includeExtensions`.
 */
export function walkFiles(rootDir: string, includeExtensions: string[]): string[] {
  const entries = safeReaddirSync(rootDir);
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