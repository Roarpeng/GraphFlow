/**
 * Branch-scoped graph caches (`src/branch-scope.ts`)
 *
 * One working tree, many branches: `git checkout` rewrites the sources underneath the
 * caches. Every store is fingerprint-validated so results never go stale, but a single
 * shared store still means each switch overwrites the other branch's entries (switching
 * back re-parses everything that differs) and mixes branches inside one file.
 *
 * This module gives every branch its own derived-index directory, transparently:
 *
 *   <root>/.graphflow/                 shared, per repository (learning data: macros,
 *                                      journals, feedback, tasks, ast-cache, exports)
 *   <root>/.graphflow/branches/<key>/  per branch (semantic index, name index, graph
 *                                      shards, doc-link stores, zh identifier map)
 *
 * - The current branch is read straight from `HEAD` (no `git` spawn), re-checked at most
 *   every {@link HEAD_RECHECK_MS} ms, and works for linked worktrees (`.git` file).
 * - A branch seen for the first time is warm-started from the most recently used branch
 *   directory (or migrated from the pre-branch-scope flat layout), so a new branch only
 *   re-indexes the files that actually differ.
 * - Directories of deleted branches and the least recently used ones beyond
 *   `GRAPHFLOW_BRANCH_CACHE_MAX` (default 8) are pruned automatically.
 * - Not a git repository, or `GRAPHFLOW_BRANCH_SCOPE=0`: the flat `.graphflow/` layout.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Store entries (files or directories, relative to the cache dir) that are branch-scoped. */
export const BRANCH_SCOPED_ENTRIES: readonly string[] = [
  "semantic-index.json",
  "semantic-index-delta.json",
  "name-index.json",
  "graph-shards.json",
  "doc-links",
  "zh-identifier-map.json",
];

const GRAPHFLOW_DIR = ".graphflow";
const BRANCHES_DIR = "branches";
const META_FILE = "branch.json";
const HEAD_RECHECK_MS = 200;
const DEFAULT_BRANCH_CACHE_MAX = 8;

export interface GitLocation {
  /** Per-worktree git dir (holds `HEAD`). */
  gitDir: string;
  /** Shared repository dir (holds `refs/`, `packed-refs`); equals `gitDir` for the main worktree. */
  commonDir: string;
}

export interface GitBranchInfo {
  /** Branch name (`feature/x`), or `detached` for a detached HEAD. */
  name: string;
  detached: boolean;
  /** Filesystem-safe, collision-free directory name for this branch. */
  key: string;
}

interface BranchMeta {
  branch: string;
  detached: boolean;
  lastUsedAt: number;
}

export function branchScopeEnabled(): boolean {
  return process.env.GRAPHFLOW_BRANCH_SCOPE !== "0";
}

function branchCacheMax(): number {
  const raw = Number.parseInt(process.env.GRAPHFLOW_BRANCH_CACHE_MAX ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_BRANCH_CACHE_MAX;
}

/** Locates the git dirs of `rootDir` when it is a worktree root (main or linked). */
export function resolveGitLocation(rootDir: string): GitLocation | undefined {
  const dotGit = join(rootDir, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  if (!st.isFile()) return undefined;
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return undefined;
    const gitDir = resolve(rootDir, match[1]!);
    let commonDir = gitDir;
    try {
      const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (common) commonDir = resolve(gitDir, common);
    } catch {
      // Submodules have no `commondir`: the git dir is the repository.
    }
    return { gitDir, commonDir };
  } catch {
    return undefined;
  }
}

/** Like {@link resolveGitLocation}, but also accepts a sub-directory of a worktree (monorepo package). */
function findGitLocationUpwards(startDir: string): GitLocation | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 32; i++) {
    const loc = resolveGitLocation(dir);
    if (loc) return loc;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function normalizeFsPath(p: string): string {
  const resolved = resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * `true` when `a` and `b` are two different worktrees of the same repository — i.e.
 * the same project on (usually) different branches, not a different project.
 */
export function isSameRepositoryWorktree(a: string, b: string): boolean {
  if (normalizeFsPath(a) === normalizeFsPath(b)) return false;
  const la = resolveGitLocation(a);
  if (!la) return false;
  const lb = resolveGitLocation(b);
  if (!lb) return false;
  return normalizeFsPath(la.commonDir) === normalizeFsPath(lb.commonDir);
}

export function branchKeyOf(name: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 48) || "branch";
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function parseHead(text: string): GitBranchInfo {
  const match = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(text);
  if (match) {
    const name = match[1]!;
    return { name, detached: false, key: branchKeyOf(name) };
  }
  // Detached HEAD (rebase, bisect, tag checkout): one shared bucket, not one per commit.
  return { name: "detached", detached: true, key: branchKeyOf("(detached)") };
}

interface HeadMemo {
  checkedAt: number;
  headPath?: string;
  branch?: GitBranchInfo;
}

const headMemo = new Map<string, HeadMemo>();

/** Current branch of the git worktree containing `rootDir`, or `undefined` outside git. */
export function currentGitBranch(rootDir: string): GitBranchInfo | undefined {
  const root = resolve(rootDir);
  const now = Date.now();
  const memo = headMemo.get(root);
  if (memo && now - memo.checkedAt < HEAD_RECHECK_MS) return memo.branch;

  let headPath = memo?.headPath;
  if (!headPath) {
    const loc = findGitLocationUpwards(root);
    headPath = loc ? join(loc.gitDir, "HEAD") : undefined;
  }
  let branch: GitBranchInfo | undefined;
  if (headPath) {
    try {
      branch = parseHead(readFileSync(headPath, "utf8"));
    } catch {
      headPath = undefined;
      branch = undefined;
    }
  }
  headMemo.set(root, { checkedAt: now, ...(headPath ? { headPath } : {}), ...(branch ? { branch } : {}) });
  return branch;
}

/** Stable key of the cache scope in effect for `rootDir` (`""` for the flat layout). */
export function branchScopeKey(rootDir: string): string {
  if (!branchScopeEnabled()) return "";
  return currentGitBranch(rootDir)?.key ?? "";
}

// ── Directory preparation: warm start, legacy migration, pruning ─────────────────────────

const preparedDirs = new Set<string>();

function copyRecursive(src: string, dest: string): void {
  let st;
  try {
    st = statSync(src);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      if (name.endsWith(".tmp") || name.startsWith(".tmp-")) continue;
      copyRecursive(join(src, name), join(dest, name));
    }
  } else if (st.isFile()) {
    copyFileSync(src, dest);
  }
}

function readMeta(dir: string): BranchMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, META_FILE), "utf8")) as Partial<BranchMeta>;
    if (typeof parsed.branch !== "string" || typeof parsed.lastUsedAt !== "number") return undefined;
    return { branch: parsed.branch, detached: parsed.detached === true, lastUsedAt: parsed.lastUsedAt };
  } catch {
    return undefined;
  }
}

function lastUsedAt(dir: string): number {
  const meta = readMeta(dir);
  if (meta) return meta.lastUsedAt;
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function listBranchDirs(branchesRoot: string): string[] {
  try {
    return readdirSync(branchesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(branchesRoot, e.name));
  } catch {
    return [];
  }
}

function branchExists(commonDir: string, name: string): boolean {
  if (existsSync(join(commonDir, "refs", "heads", ...name.split("/")))) return true;
  try {
    const packed = readFileSync(join(commonDir, "packed-refs"), "utf8");
    return packed.includes(` refs/heads/${name}\n`) || packed.endsWith(` refs/heads/${name}`);
  } catch {
    return false;
  }
}

function seedBranchDir(base: string, dir: string): void {
  // 1. Pre-branch-scope flat stores describe the current working tree: adopt them.
  const legacy = BRANCH_SCOPED_ENTRIES.filter((entry) => existsSync(join(base, entry)));
  if (legacy.length > 0) {
    for (const entry of legacy) {
      try {
        renameSync(join(base, entry), join(dir, entry));
      } catch {
        try {
          copyRecursive(join(base, entry), join(dir, entry));
        } catch {
          // Cold start for this store.
        }
      }
    }
    return;
  }
  // 2. Warm start from the most recently used branch. Every store is fingerprint-validated
  //    per file, so files identical across the two branches are hits, the rest rebuild.
  let donor: string | undefined;
  let best = -1;
  for (const candidate of listBranchDirs(join(base, BRANCHES_DIR))) {
    if (resolve(candidate) === resolve(dir)) continue;
    const used = lastUsedAt(candidate);
    if (used > best) {
      best = used;
      donor = candidate;
    }
  }
  if (!donor) return;
  for (const entry of BRANCH_SCOPED_ENTRIES) {
    try {
      copyRecursive(join(donor, entry), join(dir, entry));
    } catch {
      // Cold start for this store.
    }
  }
}

function pruneBranchDirs(root: string, base: string, keepDir: string): void {
  const dirs = listBranchDirs(join(base, BRANCHES_DIR));
  if (dirs.length <= 1) return;
  const loc = findGitLocationUpwards(root);
  const keep = resolve(keepDir);
  const survivors: Array<{ dir: string; used: number }> = [];
  for (const dir of dirs) {
    if (resolve(dir) === keep) continue;
    const meta = readMeta(dir);
    if (loc && meta && !meta.detached && !branchExists(loc.commonDir, meta.branch)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    survivors.push({ dir, used: meta?.lastUsedAt ?? lastUsedAt(dir) });
  }
  survivors.sort((a, b) => b.used - a.used);
  for (const { dir } of survivors.slice(Math.max(0, branchCacheMax() - 1))) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function prepareBranchDir(root: string, base: string, dir: string, branch: GitBranchInfo): void {
  if (preparedDirs.has(dir)) return;
  // No `.graphflow` yet: nothing to seed, and reads must stay side-effect free.
  // Writers create the directory on demand; the next process prepares it.
  if (!existsSync(base)) return;
  preparedDirs.add(dir);
  try {
    const fresh = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    if (fresh) seedBranchDir(base, dir);
    writeFileSync(
      join(dir, META_FILE),
      JSON.stringify({ branch: branch.name, detached: branch.detached, lastUsedAt: Date.now() } satisfies BranchMeta),
      "utf8"
    );
    pruneBranchDirs(root, base, dir);
  } catch {
    // Best effort: a read-only cache dir just means cold caches.
  }
}

/**
 * Directory holding the branch-scoped stores for `rootDir`'s current branch, or the flat
 * `<root>/.graphflow` when not inside a git repository or when branch scoping is disabled.
 */
export function graphCacheDir(rootDir: string): string {
  const root = resolve(rootDir);
  const base = join(root, GRAPHFLOW_DIR);
  if (!branchScopeEnabled()) return base;
  const branch = currentGitBranch(root);
  if (!branch) return base;
  const dir = join(base, BRANCHES_DIR, branch.key);
  prepareBranchDir(root, base, dir, branch);
  return dir;
}

/** Absolute path of a branch-scoped store entry (e.g. `"semantic-index.json"`). */
export function graphCachePath(rootDir: string, ...segments: string[]): string {
  return join(graphCacheDir(rootDir), ...segments);
}

/** Diagnostics for `gf_exec status`. */
export function describeBranchScope(rootDir: string): string {
  if (!branchScopeEnabled()) return "branch-scope: off (GRAPHFLOW_BRANCH_SCOPE=0)";
  const branch = currentGitBranch(rootDir);
  if (!branch) return "branch-scope: n/a (not inside a git repository)";
  const label = branch.detached ? "(detached HEAD)" : branch.name;
  return `branch: ${label} | cache: ${GRAPHFLOW_DIR}/${BRANCHES_DIR}/${branch.key}`;
}

/** Test hook: forget memoized HEAD reads and prepared directories. */
export function resetBranchScopeState(): void {
  headMemo.clear();
  preparedDirs.clear();
}
