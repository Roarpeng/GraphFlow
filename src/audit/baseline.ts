/**
 * Baseline derivation for the closing audit.
 *
 * Default strategy: the uncommitted working tree (`git diff --name-only
 * HEAD` + untracked files) — most agent sessions end with uncommitted work,
 * which is exactly the window where follow-through gets lost. `--since <ref>`
 * widens it to a ref. Projects without git fall back to `none` (stateful
 * checkers still run; baseline-consuming checkers degrade gracefully).
 */
import { execSync } from "node:child_process";

export interface AuditBaseline {
  strategy: "git-working-tree" | "git-ref" | "none";
  ref?: string;
  changedFiles: string[];
  note: string;
}

function git(args: string, root: string): string | undefined {
  try {
    return execSync(`git ${args}`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** Normalize git output lines to clean relative posix-ish paths. */
function toPaths(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, "/"))
    .map((line) => (line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line));
}

export function deriveAuditBaseline(
  root: string,
  options: { since?: string; changedFilesOverride?: string[] } = {},
  deps: { git?: typeof git } = {}
): AuditBaseline {
  if (options.changedFilesOverride) {
    return {
      strategy: "none",
      changedFiles: options.changedFilesOverride.map((f) => f.replace(/\\/g, "/")),
      note: "changed files injected (test hook)",
    };
  }
  const run = deps.git ?? git;
  const tracked = toPaths(run("diff --name-only HEAD", root));
  const untracked = toPaths(run("ls-files --others --exclude-standard", root));
  const working = [...new Set([...tracked, ...untracked])];
  if (working.length > 0 || run("rev-parse --is-inside-work-tree", root) !== undefined) {
    if (options.since) {
      const since = toPaths(run(`diff --name-only ${options.since}...HEAD`, root));
      const combined = [...new Set([...since, ...working])];
      return {
        strategy: "git-ref",
        ref: options.since,
        changedFiles: combined,
        note: `git diff ${options.since}...HEAD + uncommitted working tree`,
      };
    }
    return {
      strategy: "git-working-tree",
      changedFiles: working,
      note: "uncommitted working tree (tracked diff + untracked)",
    };
  }
  return {
    strategy: "none",
    changedFiles: [],
    note: "no git repository — stateful checkers only; pass changedFiles or configure rules accordingly",
  };
}
