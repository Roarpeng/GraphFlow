/**
 * module-summary.ts — RAPTOR-lite recursive L2 module summaries.
 *
 * The L2 layer of the graph is made of Module nodes. Until now every Module
 * node was a leaf (one per file module plus one per import target) whose
 * content was just the module path — there was no node summarizing what a
 * DIRECTORY contains, so a monorepo's `src/` offered no module-level overview
 * below the full repo map.
 *
 * This module builds deterministic directory-level Module summary nodes:
 *
 *   - one node per directory that directly contains at least one indexed file;
 *   - the content follows the repo-map line convention
 *     (`path/to/module: exports symbol1, symbol2, ...`) — the existing local,
 *     deterministic summarizer; no LLM call anywhere;
 *   - when a directory's summary would exceed
 *     {@link MODULE_SUMMARY_RECURSION_THRESHOLD_CHARS} characters or have more
 *     than {@link MODULE_SUMMARY_RECURSION_THRESHOLD_CHILDREN} direct
 *     children, the detail is pushed DOWN a level (RAPTOR-style recursion):
 *     each subdirectory keeps its own full summary node and the parent's
 *     content becomes a compact rollup (module paths and counts only, no
 *     per-file export lists);
 *   - node ids are deterministic (`module:src/graph/`, `module:.` for the
 *     workspace root) so re-indexing upserts the same ids — never duplicates.
 *
 * The tree walk is recursive: a subdirectory that itself exceeds the threshold
 * recurses again into ITS subdirectories, so a deep monorepo bottomes out in
 * summaries that each stay under the threshold.
 */

import { posix } from "node:path";
import type { GraphNode } from "../core/types.js";
import { moduleKey } from "./file-indexer-nodes.js";

/** Above this content size a directory summary recurses into subdirectories. */
export const MODULE_SUMMARY_RECURSION_THRESHOLD_CHARS = 4000;

/** Above this many direct children (files + subdirectories) a summary recurses. */
export const MODULE_SUMMARY_RECURSION_THRESHOLD_CHILDREN = 40;

/** Metadata marker identifying generated directory summary nodes (stale-cleanup scans for it). */
export const MODULE_SUMMARY_MARKER = "moduleSummary";

/** Max export names listed per file line (repo-map convention). */
const MAX_EXPORTS_PER_LINE = 10;

/** Max export names aggregated into a child-directory one-liner. */
const MAX_EXPORTS_PER_CHILD_LINE = 5;

export interface ModuleSummaryFileFact {
  relPath: string;
  /** Exported symbol names (File node `metadata.exports`); empty when none. */
  exports?: readonly string[];
}

export interface DirectoryModuleSummary {
  node: GraphNode;
  /** True when the content is a compact rollup (detail pushed to children). */
  recursive: boolean;
}

interface DirectoryEntry {
  /** Directory path, POSIX, "" = workspace root. */
  dir: string;
  /** Files directly inside this directory, sorted by relPath. */
  files: ModuleSummaryFileFact[];
  /** Direct child directories that themselves contain indexed files, sorted. */
  children: DirectoryEntry[];
}

/** Deterministic node id for a directory module summary. */
export function directoryModuleNodeId(dir: string): string {
  const normalized = dir.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === "" || normalized === "." ? "module:." : `module:${normalized}/`;
}

function parentDirOf(posixPath: string): string {
  const parent = posix.dirname(posixPath.replace(/\\/g, "/"));
  return parent === "." ? "" : parent;
}

function buildDirectoryTree(files: readonly ModuleSummaryFileFact[]): DirectoryEntry {
  const root: DirectoryEntry = { dir: "", files: [], children: [] };
  const byDir = new Map<string, DirectoryEntry>([["", root]]);

  const entryFor = (dir: string): DirectoryEntry => {
    const existing = byDir.get(dir);
    if (existing) {
      return existing;
    }
    const entry: DirectoryEntry = { dir, files: [], children: [] };
    byDir.set(dir, entry);
    entryFor(parentDirOf(dir)).children.push(entry);
    return entry;
  };

  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const file of sorted) {
    entryFor(parentDirOf(file.relPath)).files.push(file);
  }
  for (const entry of byDir.values()) {
    entry.children.sort((a, b) => a.dir.localeCompare(b.dir));
  }
  return root;
}

function fileLine(file: ModuleSummaryFileFact, withExports: boolean): string {
  const key = moduleKey(file.relPath);
  const exports = withExports ? uniqueExports(file.exports) : [];
  if (exports.length === 0) {
    return key;
  }
  return `${key}: exports ${exports.slice(0, MAX_EXPORTS_PER_LINE).join(", ")}${
    exports.length > MAX_EXPORTS_PER_LINE ? ", ..." : ""
  }`;
}

function uniqueExports(exports: readonly string[] | undefined): string[] {
  if (!exports || exports.length === 0) {
    return [];
  }
  return Array.from(new Set(exports.filter((name) => typeof name === "string" && name.length > 0)));
}

function childLine(child: DirectoryEntry, withExports: boolean): string {
  const name = child.dir.split("/").pop() ?? child.dir;
  const exports = withExports
    ? Array.from(new Set(child.files.flatMap((file) => uniqueExports(file.exports))))
    : [];
  const exportSuffix =
    exports.length > 0 ? `, exports ${exports.slice(0, MAX_EXPORTS_PER_CHILD_LINE).join(", ")}${exports.length > MAX_EXPORTS_PER_CHILD_LINE ? ", ..." : ""}` : "";
  return `${name}/ (${child.files.length} files${exportSuffix})`;
}

function summarizeDirectory(entry: DirectoryEntry): DirectoryModuleSummary {
  const pathLabel = entry.dir === "" ? "." : `${entry.dir}/`;
  const directChildren = entry.files.length + entry.children.length;

  const fullLines = [
    `${pathLabel} # module summary: ${entry.files.length} files, ${entry.children.length} submodules`,
    ...entry.files.map((file) => fileLine(file, true)),
    ...entry.children.map((child) => childLine(child, true)),
  ];
  const fullContent = fullLines.join("\n");

  const recursive =
    fullContent.length > MODULE_SUMMARY_RECURSION_THRESHOLD_CHARS ||
    directChildren > MODULE_SUMMARY_RECURSION_THRESHOLD_CHILDREN;

  // Rollup: keep the structure (module paths, counts) but drop per-file export
  // detail — that now lives on the child submodule summary nodes.
  const content = recursive
    ? [
        `${pathLabel} # module rollup: ${entry.files.length} files, ${entry.children.length} submodules (detail on submodule summaries)`,
        ...entry.files.map((file) => fileLine(file, false)),
        ...entry.children.map((child) => childLine(child, false)),
      ].join("\n")
    : fullContent;

  return {
    node: {
      id: directoryModuleNodeId(entry.dir),
      type: "Module",
      content,
      metadata: {
        path: entry.dir === "" ? "." : entry.dir,
        [MODULE_SUMMARY_MARKER]: true,
        files: entry.files.length,
        submodules: entry.children.length,
        ...(recursive ? { recursive: true } : {}),
      },
    },
    recursive,
  };
}

/**
 * Build the directory module summary nodes for the given (effective, current)
 * file set. One node per directory with at least one direct file; directories
 * over the recursion threshold emit compact rollups while their children carry
 * the detail.
 */
export function buildDirectoryModuleSummaries(
  files: readonly ModuleSummaryFileFact[]
): DirectoryModuleSummary[] {
  const root = buildDirectoryTree(files);
  const out: DirectoryModuleSummary[] = [];
  const walk = (entry: DirectoryEntry): void => {
    if (entry.files.length > 0) {
      out.push(summarizeDirectory(entry));
    }
    for (const child of entry.children) {
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * Ids of previously generated directory summary nodes that no longer have a
 * live counterpart (their directory lost its last indexed file). Detecting
 * them by the {@link MODULE_SUMMARY_MARKER} metadata keeps user/import module
 * nodes untouched.
 */
export function findStaleModuleSummaryNodeIds(
  snapshotNodes: readonly GraphNode[] | undefined,
  liveIds: ReadonlySet<string>
): string[] {
  if (!snapshotNodes) {
    return [];
  }
  const stale: string[] = [];
  for (const node of snapshotNodes) {
    if (node.type !== "Module" || node.metadata?.[MODULE_SUMMARY_MARKER] !== true) {
      continue;
    }
    if (!liveIds.has(node.id)) {
      stale.push(node.id);
    }
  }
  return stale;
}
