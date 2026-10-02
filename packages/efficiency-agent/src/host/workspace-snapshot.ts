import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { porcelainStatusMap } from "../security/policy.js";
import type { WorkspaceSnapshot } from "../security/write-audit.js";
import { resolveSpawn } from "./spawn-command.js";

/**
 * Workspace snapshot for the post-run write audit (see security/write-audit.ts).
 * Bounded by construction: ignored directories are single `git status` entries
 * (never walked), and content is signed only for a limited number of dirty /
 * ignored files under a per-file and a total byte budget; anything over the
 * budget falls back to a size+mtime signature or is counted as `unsigned`.
 */

export interface SnapshotLimits {
  /** Max pre-dirty (tracked-modified or untracked) files to sign. */
  maxDirtyFiles: number;
  /** Max git-ignored files to sign (ignored directories are never walked). */
  maxIgnoredFiles: number;
  /** Files larger than this get a "stat:" signature instead of sha256. */
  maxFileBytes: number;
  /** Total bytes hashed per snapshot; beyond it signatures fall back to "stat:". */
  maxTotalBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxDirtyFiles: 2_000,
  maxIgnoredFiles: 256,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

export type GitRunner = (args: string[], cwd: string) => string;

const defaultGit: GitRunner = (args, cwd) => {
  const spec = resolveSpawn("git", args);
  return execFileSync(spec.command, spec.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
};

function signFile(abs: string, mode: "hash" | "stat", budget: { bytes: number }, limits: SnapshotLimits): string {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    if (st.isDirectory()) return "dir";
    if (mode === "hash" && st.size <= limits.maxFileBytes && budget.bytes + st.size <= limits.maxTotalBytes) {
      budget.bytes += st.size;
      return `sha256:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
    }
    return `stat:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Take a snapshot of `root` (undefined when it is not inside a git work tree).
 * Pass the pre-run snapshot as `before` to re-sign exactly the same files with
 * the same method, so signatures are comparable.
 */
export function takeWorkspaceSnapshot(
  root: string,
  before?: WorkspaceSnapshot,
  options: { limits?: Partial<SnapshotLimits>; git?: GitRunner } = {}
): WorkspaceSnapshot | undefined {
  const git = options.git ?? defaultGit;
  const limits: SnapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits };
  let prefix: string;
  let status: string[];
  try {
    // The root does not move during a run: the post-run snapshot reuses the prefix.
    prefix = before ? before.prefix : git(["rev-parse", "--show-prefix"], root).trim().replace(/\\/g, "/");
    status = git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], root)
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  } catch {
    return undefined;
  }
  const depth = prefix.split("/").filter(Boolean).length;
  const top = path.resolve(root, ...Array<string>(depth).fill(".."));
  const abs = (repoPath: string): string => path.join(top, ...repoPath.split("/").filter(Boolean));
  const budget = { bytes: 0 };
  const contents: Record<string, string> = {};

  if (before) {
    for (const [p, signature] of Object.entries(before.contents)) {
      // Same method as before: a file signed by sha256 is hashed again even if
      // the total budget is spent (bounded by the pre-run set and maxFileBytes).
      contents[p] = signFile(abs(p), signature.startsWith("sha256:") ? "hash" : "stat", { bytes: 0 }, limits);
    }
    return { prefix, status, contents, unsigned: before.unsigned };
  }

  let dirty = 0;
  let ignored = 0;
  let unsigned = 0;
  for (const [p, st] of porcelainStatusMap(status)) {
    if (st === "!!") {
      if (p.endsWith("/")) continue; // ignored directory: entry-level comparison only
      if (ignored >= limits.maxIgnoredFiles) {
        unsigned++;
        continue;
      }
      ignored++;
    } else {
      if (dirty >= limits.maxDirtyFiles) {
        unsigned++;
        continue;
      }
      dirty++;
    }
    contents[p] = signFile(abs(p), "hash", budget, limits);
  }
  return { prefix, status, contents, unsigned };
}
