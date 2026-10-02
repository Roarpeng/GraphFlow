import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectStateFacts } from "../domain.js";
import type { ProjectTwinFacts } from "../project-twin.js";

/**
 * Host-side fact collection (2.x plan §8 / §10): the only place the
 * efficiency layer touches the project's filesystem and git. Everything it
 * returns is a measured fact (git output, file bytes) — a missing fact stays
 * undefined instead of being replaced by a placeholder.
 */

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|st|scl|json|md)$/i;
const SYMBOL_SCAN_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const EXPORT_SYMBOL =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const MAX_LISTED_FILES = 4000;
const MAX_SYMBOL_SCAN_FILES = 600;
const MAX_SYMBOL_SCAN_BYTES = 200_000;
const MAX_RELEVANT_FILES = 8;
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock"];

export interface CollectedProjectFacts {
  /** Facts for buildProjectTwin. */
  twinFacts: ProjectTwinFacts;
  /** Project track of the four-track fingerprint. */
  projectState: ProjectStateFacts;
  /** Repo-relative paths whose content hashes bind the fingerprint. */
  relevantFiles: string[];
  /** Exported symbols per scanned file (repo-relative path → names). */
  symbolsByFile: Map<string, string[]>;
  isGitRepo: boolean;
}

export interface CollectProjectFactsOptions {
  /** Extra repo-relative files known to matter (e.g. GraphFlow anchor files). */
  extraRelevantFiles?: string[];
}

function sha16(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  } catch {
    return undefined;
  }
}

function readPackageJson(root: string): ProjectTwinFacts["packageJson"] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: string;
      main?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    return {
      ...(pkg.name ? { name: pkg.name } : {}),
      ...(pkg.main ? { main: pkg.main } : {}),
      scripts: pkg.scripts ?? {},
      dependencies: Object.keys(pkg.dependencies ?? {}),
    };
  } catch {
    return undefined;
  }
}

function hashFile(root: string, rel: string): string | undefined {
  try {
    return sha16(readFileSync(join(root, rel)));
  } catch {
    return undefined;
  }
}

function scanSymbols(root: string, files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rel of files.filter((file) => SYMBOL_SCAN_FILE.test(file)).slice(0, MAX_SYMBOL_SCAN_FILES)) {
    try {
      const abs = join(root, rel);
      if (statSync(abs).size > MAX_SYMBOL_SCAN_BYTES) continue;
      const names = new Set<string>();
      for (const match of readFileSync(abs, "utf8").matchAll(EXPORT_SYMBOL)) {
        names.add(match[1]!);
      }
      if (names.size > 0) out.set(rel, [...names]);
    } catch {
      // Unreadable file: contributes no symbols.
    }
  }
  return out;
}

/** Lowercased word tokens (>= 3 chars), splitting camelCase and paths. */
export function taskTokens(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return Array.from(
    new Set(
      spaced
        .toLowerCase()
        .split(/[^a-z0-9\u3400-\u9fff]+/)
        .filter((token) => token.length >= 3)
    )
  );
}

/**
 * Files whose path or exported symbols overlap the task text, best first.
 * Verbatim path mentions always win; ties break on path for determinism.
 */
export function rankRelevantFiles(
  task: string,
  files: string[],
  symbolsByFile: Map<string, string[]>,
  limit = MAX_RELEVANT_FILES
): string[] {
  const tokens = new Set(taskTokens(task));
  const lowerTask = task.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    let score = 0;
    if (lowerTask.includes(file.toLowerCase())) score += 100;
    for (const token of taskTokens(file)) {
      if (tokens.has(token)) score += 2;
    }
    for (const symbol of symbolsByFile.get(file) ?? []) {
      if (lowerTask.includes(symbol.toLowerCase())) score += 10;
      else if (taskTokens(symbol).some((token) => tokens.has(token))) score += 1;
    }
    if (score > 0) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return scored.slice(0, limit).map((entry) => entry.file);
}

export function collectProjectFacts(
  root: string,
  task: string,
  options: CollectProjectFactsOptions = {}
): CollectedProjectFacts {
  const head = git(root, ["rev-parse", "HEAD"])?.trim();
  const isGitRepo = head !== undefined && /^[0-9a-f]{40}$/.test(head);
  // The efficiency layer's own state dir must not churn its fingerprint.
  const status = isGitRepo
    ? git(root, ["status", "--porcelain", "--", ".", ":(exclude)graphflow-out"])
    : undefined;
  const listed = isGitRepo ? git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]) : undefined;
  const files = (listed ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0 && CODE_FILE.test(line))
    .slice(0, MAX_LISTED_FILES);
  const symbolsByFile = scanSymbols(root, files);

  const ranked = rankRelevantFiles(task, files, symbolsByFile);
  const extra = (options.extraRelevantFiles ?? []).filter((file) => existsSync(join(root, file)));
  const relevantFiles = Array.from(new Set([...extra, ...ranked])).slice(0, MAX_RELEVANT_FILES * 2);
  const relevantFileHashes: Record<string, string> = {};
  for (const rel of relevantFiles) {
    const hash = hashFile(root, rel);
    if (hash) relevantFileHashes[rel] = hash;
  }

  let dependencyLockHash: string | undefined;
  for (const lock of LOCKFILES) {
    const hash = hashFile(root, lock);
    if (hash) {
      dependencyLockHash = `${lock}:${hash}`;
      break;
    }
  }

  const commits = isGitRepo ? git(root, ["log", "--oneline", "-10"]) : undefined;
  const packageJson = readPackageJson(root);

  return {
    twinFacts: {
      root,
      ...(packageJson ? { packageJson } : {}),
      fileMap: files.map((path) => ({ path, symbols: symbolsByFile.get(path) ?? [] })),
      recentCommits: (commits ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0),
    },
    projectState: {
      ...(isGitRepo ? { gitHead: head } : {}),
      ...(status !== undefined ? { workingTreeHash: sha16(status) } : {}),
      relevantFileHashes,
      ...(dependencyLockHash ? { dependencyLockHash } : {}),
    },
    relevantFiles: Object.keys(relevantFileHashes),
    symbolsByFile,
    isGitRepo,
  };
}

/** Context-track graph identity: the GraphFlow graph artifact's size + mtime. */
export function graphArtifactVersion(root: string): string | undefined {
  for (const rel of ["graphflow-out/graphflow-graph.json", "graphflow-out/graph-store.json"]) {
    try {
      const stat = statSync(join(root, rel));
      return `${basename(rel)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
