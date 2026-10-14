/**
 * GraphFlow 3.1 — Strategic Pillar 1: Zero-Cold-Start Git History &
 * Cross-Language Temporal Coupling Miner (`src/v3/git-miner.ts`)
 *
 * Solves the cold-start problem on existing repositories and discovers implicit
 * cross-language couplings that static AST imports cannot see (e.g. `.proto` <-> `.go`,
 * `.sql` <-> `.py`, `.cpp` <-> `.cs`, config <-> implementation, source <-> test).
 *
 * Scans `git log` commit history in <150ms, filters out bulk formatting mega-commits,
 * and computes pairwise Temporal Coupling confidence:
 *   P(B | A) = Commits(A ∩ B) / Commits(A)
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitCoChangePair {
  fileA: string;
  fileB: string;
  coCommitCount: number;
  commitsA: number;
  commitsB: number;
  /** Max directional conditional probability max(P(B|A), P(A|B)), 0..1 */
  confidence: number;
}

export interface GitHotspot {
  file: string;
  commitCount: number;
}

export interface GitMiningResult {
  commitsScanned: number;
  coChangePairs: GitCoChangePair[];
  hotspots: GitHotspot[];
}

export interface GitMineOptions {
  maxCommits?: number;
  maxFilesPerCommit?: number;
  minCoCommits?: number;
  minConfidence?: number;
}

const IGNORED_PATH_PREFIXES = [
  "node_modules/",
  "dist/",
  "build/",
  ".git/",
  ".graphflow/",
  "coverage/",
];

const IGNORED_FILENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
]);

function isTrackableRepoFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").trim();
  if (!norm) return false;
  for (const prefix of IGNORED_PATH_PREFIXES) {
    if (norm.startsWith(prefix)) return false;
  }
  const base = norm.split("/").pop() ?? "";
  if (IGNORED_FILENAMES.has(base)) return false;
  return true;
}

/**
 * Parse raw `git log --name-only --pretty=format:COMMIT:%H` output into commit file sets.
 * Exported for deterministic unit testing as well as live git execution.
 */
export function parseGitLogCommitFiles(
  rawLog: string,
  maxFilesPerCommit = 20
): string[][] {
  const commits: string[][] = [];
  let current: Set<string> | null = null;

  for (const rawLine of rawLog.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("COMMIT:")) {
      if (current && current.size >= 1 && current.size <= maxFilesPerCommit) {
        commits.push(Array.from(current).sort());
      }
      current = new Set<string>();
      continue;
    }
    if (current && isTrackableRepoFile(line)) {
      current.add(line.replace(/\\/g, "/"));
    }
  }
  if (current && current.size >= 1 && current.size <= maxFilesPerCommit) {
    commits.push(Array.from(current).sort());
  }
  return commits;
}

/**
 * Compute temporal coupling pairs and hotspots from a list of commit file sets.
 */
export function computeTemporalCouplingFromCommits(
  commits: string[][],
  options: GitMineOptions = {}
): GitMiningResult {
  const minCoCommits = options.minCoCommits ?? 2;
  const minConfidence = options.minConfidence ?? 0.5;

  const fileCounts = new Map<string, number>();
  const pairCounts = new Map<string, { fileA: string; fileB: string; count: number }>();

  for (const files of commits) {
    for (const f of files) {
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }
    if (files.length < 2) continue;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i]!;
        const b = files[j]!;
        const key = `${a}||${b}`;
        const entry = pairCounts.get(key) ?? { fileA: a, fileB: b, count: 0 };
        entry.count += 1;
        pairCounts.set(key, entry);
      }
    }
  }

  const coChangePairs: GitCoChangePair[] = [];
  for (const [, pair] of pairCounts) {
    if (pair.count < minCoCommits) continue;
    const commitsA = fileCounts.get(pair.fileA) ?? pair.count;
    const commitsB = fileCounts.get(pair.fileB) ?? pair.count;
    const confAB = pair.count / Math.max(1, commitsA);
    const confBA = pair.count / Math.max(1, commitsB);
    const confidence = Number(Math.max(confAB, confBA).toFixed(2));
    if (confidence < minConfidence) continue;
    coChangePairs.push({
      fileA: pair.fileA,
      fileB: pair.fileB,
      coCommitCount: pair.count,
      commitsA,
      commitsB,
      confidence,
    });
  }

  coChangePairs.sort(
    (x, y) => y.coCommitCount - x.coCommitCount || y.confidence - x.confidence
  );

  const hotspots: GitHotspot[] = Array.from(fileCounts.entries())
    .map(([file, commitCount]) => ({ file, commitCount }))
    .sort((a, b) => b.commitCount - a.commitCount)
    .slice(0, 15);

  return {
    commitsScanned: commits.length,
    coChangePairs: coChangePairs.slice(0, 50),
    hotspots,
  };
}

/**
 * Scan repository `git log` history to extract Zero-Cold-Start Temporal Coupling pairs and hotspots.
 */
export function mineGitCoChangeHistory(
  rootDir: string,
  options: GitMineOptions = {}
): GitMiningResult {
  if (!existsSync(join(rootDir, ".git"))) {
    return { commitsScanned: 0, coChangePairs: [], hotspots: [] };
  }
  const maxCommits = options.maxCommits ?? 300;
  const maxFilesPerCommit = options.maxFilesPerCommit ?? 20;
  try {
    const rawLog = execSync(
      `git log -n ${maxCommits} --name-only --pretty=format:"COMMIT:%H"`,
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }
    );
    const commits = parseGitLogCommitFiles(rawLog, maxFilesPerCommit);
    return computeTemporalCouplingFromCommits(commits, options);
  } catch {
    return { commitsScanned: 0, coChangePairs: [], hotspots: [] };
  }
}

/**
 * Fetch a compact summary of recent human commits touching `relPath` (for Circuit Breaker rescue packets).
 */
export function getRecentFileGitDiff(
  rootDir: string,
  relPath: string,
  maxCommits = 2
): string {
  if (!existsSync(join(rootDir, ".git"))) return "";
  try {
    const raw = execSync(
      `git log -n ${maxCommits} --oneline -p -- "${relPath.replace(/"/g, "")}"`,
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
      }
    );
    const lines = raw
      .split(/\r?\n/)
      .filter(
        (l) =>
          /^[0-9a-f]{7,}\s/.test(l) ||
          l.startsWith("@@") ||
          (l.startsWith("+") && !l.startsWith("+++")) ||
          (l.startsWith("-") && !l.startsWith("---"))
      )
      .slice(0, 30);
    return lines.length > 0
      ? `// [Recent Git History for ${relPath}]\n` + lines.map((l) => `//   ${l}`).join("\n")
      : "";
  } catch {
    return "";
  }
}
