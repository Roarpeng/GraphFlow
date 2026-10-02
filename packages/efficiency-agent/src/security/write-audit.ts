import path from "node:path";
import type { RiskClass, TraceSecurityDecision } from "../trace.js";
import { evaluateAction, matchProtectedPath, porcelainStatusMap, type SecurityPolicy } from "./policy.js";

/**
 * Post-run write audit over full workspace snapshots (spec §6–§8). A plain
 * before/after diff of `git status` file lists has three blind spots this
 * module closes:
 *  (a) a file already dirty before the run and modified again keeps its
 *      status — compared by content signature (sha256) instead;
 *  (b) git-ignored files never appear in `git status` — the snapshot uses
 *      `--ignored=matching` (ignored directories stay one entry, so huge trees
 *      like node_modules are never enumerated) and signs small ignored files;
 *  (c) porcelain paths are relative to the repository top, not the workspace
 *      root — when the root is a sub-directory they are re-based, so a write
 *      to a sibling directory surfaces as `../…` and is denied as outside the
 *      root; declared write scopes outside the root are rejected too.
 * Writes outside the git repository itself remain unobservable here.
 */

export interface WorkspaceSnapshot {
  /** `git rev-parse --show-prefix`: the workspace root relative to the repo top ("" at the top, else "dir/"). */
  prefix: string;
  /** `git status --porcelain=v1 --untracked-files=all --ignored=matching` lines (repo-relative paths). */
  status: string[];
  /**
   * Repo-relative path => content signature for pre-dirty and (bounded) ignored files:
   * "sha256:<hex>", "stat:<size>:<mtimeMs>" (over the hashing bound), "link:<target>", "dir", "missing".
   */
  contents: Record<string, string>;
  /** Dirty/ignored files left unsigned because a snapshot bound was hit. */
  unsigned: number;
}

export interface WriteAuditResult {
  decision: TraceSecurityDecision;
  /** Every path written during the run, relative to the workspace root (outside the root: "../…"). */
  newlyChanged: string[];
  /** Subset: files dirty before the run whose content changed while their git status did not. */
  rewrittenDirty: string[];
  /** Subset: git-ignored entries that appeared, disappeared or changed content. */
  ignoredChanged: string[];
  /** Subset: paths outside the workspace root. */
  outsideRoot: string[];
  /** Coverage limits worth surfacing (never a reason to deny on their own). */
  notes: string[];
}

const RISK_ORDER: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5"];
const VERDICT_RANK: Record<TraceSecurityDecision["verdict"], number> = { allow: 0, "approval-required": 1, deny: 2 };

/** True when `target` (absolute, or relative to `root`) is the root or lies below it; handles `..` and other drives. */
export function isInsideRoot(root: string, target: string): boolean {
  const base = path.resolve(root);
  const rel = path.relative(base, path.resolve(base, target));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // another drive / UNC share on Windows
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../");
}

/** Re-base a repo-relative porcelain path onto the workspace root (prefix "pkg/" + "../x" for paths outside it). */
export function toRootRelative(prefix: string, repoPath: string): string {
  if (prefix === "") return repoPath;
  if (repoPath.startsWith(prefix)) return repoPath.slice(prefix.length);
  const rel = path.posix.relative(prefix.replace(/\/+$/, ""), repoPath.replace(/\/+$/, ""));
  return repoPath.endsWith("/") ? `${rel}/` : rel;
}

/** Declared write scope (contract `permissions.write`): every entry must stay inside the workspace root. */
export function checkWriteScope(workspaceRoot: string, scope: readonly string[]): TraceSecurityDecision {
  const outside = scope.filter((entry) => typeof entry !== "string" || !entry.trim() || !isInsideRoot(workspaceRoot, entry));
  if (outside.length === 0) {
    return { verdict: "allow", risk: "R0", reasons: [`declared write scope (${scope.length} path(s)) is inside the workspace root`] };
  }
  return {
    verdict: "deny",
    risk: "R3",
    reasons: outside.map((entry) => `declared write scope outside the workspace root (${String(entry)})`),
  };
}

function combine(decisions: TraceSecurityDecision[]): TraceSecurityDecision {
  const verdict = decisions.reduce<TraceSecurityDecision["verdict"]>(
    (v, d) => (VERDICT_RANK[d.verdict] > VERDICT_RANK[v] ? d.verdict : v),
    "allow"
  );
  const risk = decisions.reduce<RiskClass>((r, d) => (RISK_ORDER.indexOf(d.risk) > RISK_ORDER.indexOf(r) ? d.risk : r), "R0");
  return { verdict, risk, reasons: [...new Set(decisions.flatMap((d) => d.reasons))] };
}

const preview = (paths: string[]): string => paths.slice(0, 5).join(", ") + (paths.length > 5 ? `, … (+${paths.length - 5})` : "");

/** Compare snapshots taken before/after a worker run and evaluate everything written as a write action. */
export function auditWorkspaceSnapshots(input: {
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
  workspaceRoot: string;
  readOnly: boolean;
  policy: SecurityPolicy;
  /** Root-relative globs for paths eff-agent itself writes. */
  ignorePaths?: string[];
  /** Declared write scope (absolute or root-relative); observed writes outside it are denied. */
  writeScope?: string[];
}): WriteAuditResult {
  const before = porcelainStatusMap(input.before.status);
  const after = porcelainStatusMap(input.after.status);
  const changed = new Set<string>();
  const rewritten = new Set<string>();
  const ignored = new Set<string>();
  for (const [p, st] of after) {
    if (before.get(p) !== st) {
      changed.add(p);
      if (st === "!!" || before.get(p) === "!!") ignored.add(p);
    }
  }
  for (const [p, st] of before) {
    if (!after.has(p)) {
      changed.add(p);
      if (st === "!!") ignored.add(p);
    }
  }
  for (const [p, signature] of Object.entries(input.before.contents)) {
    if (changed.has(p)) continue;
    if ((input.after.contents[p] ?? "missing") === signature) continue;
    changed.add(p);
    if (before.get(p) === "!!") ignored.add(p);
    else rewritten.add(p);
  }

  const notes: string[] = [];
  if (input.before.prefix !== input.after.prefix) {
    notes.push("workspace prefix changed during the run; paths re-based on the pre-run prefix");
  }
  if (input.before.unsigned > 0) {
    notes.push(`${input.before.unsigned} dirty/ignored file(s) over the snapshot bounds were compared by git status only`);
  }

  const ignore = input.ignorePaths ?? [];
  const keep = (rel: string): boolean => !ignore.length || matchProtectedPath(rel, ignore) === null;
  const rebase = (set: Set<string>): string[] =>
    [...set].map((p) => toRootRelative(input.before.prefix, p)).filter(keep);
  const newlyChanged = rebase(changed);
  const rewrittenDirty = rebase(rewritten);
  const ignoredChanged = rebase(ignored);
  const outsideRoot = newlyChanged.filter((p) => !isInsideRoot(input.workspaceRoot, p));

  const decisions: TraceSecurityDecision[] = [];
  if (input.writeScope) {
    const declared = checkWriteScope(input.workspaceRoot, input.writeScope);
    if (declared.verdict !== "allow") decisions.push(declared);
    const scope = input.writeScope.filter((entry) => isInsideRoot(input.workspaceRoot, entry));
    const root = path.resolve(input.workspaceRoot);
    const unscoped = newlyChanged.filter(
      (p) => isInsideRoot(root, p) && !scope.some((entry) => isInsideRoot(path.resolve(root, entry), path.resolve(root, p)))
    );
    if (unscoped.length > 0 && !input.readOnly) {
      decisions.push({ verdict: "deny", risk: "R3", reasons: [`write outside the declared write scope (${preview(unscoped)})`] });
    }
  }

  if (newlyChanged.length === 0) {
    const base: TraceSecurityDecision = { verdict: "allow", risk: "R0", reasons: ["no new workspace writes detected", ...notes] };
    return { decision: combine([base, ...decisions]), newlyChanged, rewrittenDirty, ignoredChanged, outsideRoot, notes };
  }
  const write = evaluateAction(
    { kind: "write", paths: newlyChanged, workspaceRoot: input.workspaceRoot, readOnly: input.readOnly },
    input.policy
  );
  const findings = [
    `audit: ${newlyChanged.length} path(s) changed during the run`,
    ...(rewrittenDirty.length ? [`audit: re-modified file(s) that were already dirty before the run: ${preview(rewrittenDirty)}`] : []),
    ...(ignoredChanged.length ? [`audit: git-ignored path(s) written: ${preview(ignoredChanged)}`] : []),
    ...(outsideRoot.length ? [`audit: write(s) outside the workspace root: ${preview(outsideRoot)}`] : []),
  ];
  const decision = combine([{ ...write, reasons: [...findings, ...write.reasons, ...notes] }, ...decisions]);
  return { decision, newlyChanged, rewrittenDirty, ignoredChanged, outsideRoot, notes };
}
