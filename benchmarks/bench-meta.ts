/**
 * bench-meta.ts — shared reproducibility metadata for benchmark runners.
 *
 * Every machine-readable benchmark artifact embeds this envelope so third
 * parties can attribute a result to an exact source state (git commit) and
 * run environment. Falls back gracefully when git is unavailable (CI provides
 * GITHUB_SHA; a plain source drop yields "unknown").
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BENCH_DIR = __dirname;

/**
 * Resolve the git revision the benchmark ran against.
 * Order: `git rev-parse HEAD` → $GITHUB_SHA → "unknown".
 */
export function getCommitHash(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (sha) return sha;
  } catch {
    // git missing or not a git checkout — fall through.
  }
  return process.env.GITHUB_SHA ?? "unknown";
}

/** Standard reproducibility envelope for machine-readable results. */
export interface BenchMeta {
  schemaVersion: number;
  benchmark: string;
  generatedAt: string;
  commit: string;
  environment: {
    node: string;
    platform: string;
  };
}

export function benchMeta(benchmark: string): BenchMeta {
  return {
    schemaVersion: 1,
    benchmark,
    generatedAt: new Date().toISOString(),
    commit: getCommitHash(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    },
  };
}
