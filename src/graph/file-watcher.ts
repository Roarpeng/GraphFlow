/**
 * file-watcher.ts — Native OS file watcher with debounced auto-sync
 *
 * Inspired by CodeGraph Always Fresh:
 * - Uses Node.js fs.watch (FSEvents / inotify / ReadDirectoryChangesW)
 * - Debounced flush (default 2000 ms)
 * - Deduplicates Windows double-fire via pendingFiles Set
 * - Ignores build artifacts, dependency dirs, and hidden caches
 */

import { watch, type FSWatcher, statSync, readdirSync } from "node:fs";
import { join, sep, extname } from "node:path";
import { resolveConfig } from "../config/resolve.js";
import { resolveIncludeExtensions } from "../config/include-extensions.js";
import { logger } from "../utils/logger.js";

const DEFAULT_DEBOUNCE_MS = 2000;

const WATCH_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "tmp",
  "dist",
  "coverage",
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
  ".vscode",
  ".idea",
  ".next",
  "build",
  "install",
  "log",
  ".graphflow-cache",
  "graphflow-out",
  ".codegraph",
]);

export class GraphFileWatcher {
  private rootDir: string;
  private configPath: string | undefined;
  private debounceMs: number;
  private pendingFiles = new Set<string>();
  private watchers = new Map<string, FSWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private changeCallbacks: Array<(files: string[]) => void> = [];
  private includeExtensions: string[] = [];
  private started = false;

  constructor(rootDir: string, configPath?: string, debounceMs?: number) {
    this.rootDir = rootDir;
    this.configPath = configPath;
    this.debounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    try {
      const config = resolveConfig(this.configPath);
      this.includeExtensions = resolveIncludeExtensions(config.graphPolicy.includeExtensions);
    } catch (error) {
      logger.warn({ error }, "Failed to resolve config for file watcher; using no extension filter");
      this.includeExtensions = [];
    }

    this.setupWatchers(this.rootDir);
    logger.info({ rootDir: this.rootDir, debounceMs: this.debounceMs }, "GraphFileWatcher started");
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.pendingFiles.clear();

    logger.info({ rootDir: this.rootDir }, "GraphFileWatcher stopped");
  }

  getPendingFiles(): string[] {
    return Array.from(this.pendingFiles);
  }

  onChange(callback: (files: string[]) => void): void {
    this.changeCallbacks.push(callback);
  }

  private setupWatchers(dir: string): void {
    if (!this.started) {
      return;
    }

    const dirName = dir.split(sep).pop();
    if (dirName && WATCH_IGNORED_DIRS.has(dirName)) {
      return;
    }

    if (this.watchers.has(dir)) {
      return;
    }

    try {
      const watcher = watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename || !this.started) {
          return;
        }
        const filenameStr = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
        this.handleEvent(dir, eventType, filenameStr);
      });

      watcher.on("error", (error) => {
        logger.warn({ dir, error }, "File watcher error");
      });

      this.watchers.set(dir, watcher);
    } catch (error) {
      logger.warn({ dir, error }, "Failed to watch directory");
      return;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          continue;
        }
        if (WATCH_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        const childDir = join(dir, entry.name);
        this.setupWatchers(childDir);
      }
    } catch (error) {
      logger.warn({ dir, error }, "Failed to read directory for recursive watch setup");
    }
  }

  private handleEvent(dir: string, _eventType: string, filename: string): void {
    const fullPath = join(dir, filename);

    const parts = fullPath.split(sep);
    for (const part of parts) {
      if (WATCH_IGNORED_DIRS.has(part)) {
        return;
      }
    }

    let isDirectory = false;
    let pathExists = false;
    try {
      const stat = statSync(fullPath);
      pathExists = true;
      isDirectory = stat.isDirectory();
    } catch {
      pathExists = false;
    }

    if (pathExists && isDirectory) {
      if (!this.watchers.has(fullPath)) {
        this.setupWatchers(fullPath);
      }
      return;
    }

    if (!pathExists && this.watchers.has(fullPath)) {
      this.watchers.get(fullPath)?.close();
      this.watchers.delete(fullPath);
      return;
    }

    if (this.includeExtensions.length > 0) {
      const ext = extname(fullPath).toLowerCase();
      if (!this.includeExtensions.includes(ext)) {
        return;
      }
    }

    const normalized = fullPath.replace(/\\/g, "/");
    if (!this.pendingFiles.has(normalized)) {
      this.pendingFiles.add(normalized);
      logger.debug({ file: normalized }, "File change detected");
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.pendingFiles.size === 0) {
      return;
    }

    const files = Array.from(this.pendingFiles);
    this.pendingFiles.clear();
    this.debounceTimer = null;

    logger.info({ count: files.length }, "File watcher debounce triggered; flushing changes");

    for (const callback of this.changeCallbacks) {
      try {
        callback(files);
      } catch (error) {
        logger.warn({ error }, "File watcher onChange callback failed");
      }
    }
  }
}
