import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GraphClient } from "../graph/client-factory";
import { loadAllEpisodes, type EpisodeRecord } from "./episodic-memory";
import type { OutcomeEvidenceInput } from "./evidence";

/**
 * Close episodes from evidence that exists whether or not the agent cooperates.
 *
 * The flywheel starves because `pass` arrives only through
 * `graphflow_report_outcome`, a self-report: measured on this repo, 179 of 189
 * episodes are still pending and none carry an evidence package. This module
 * asks a question the workspace can answer — did the code the episode named
 * actually land, and is the suite green right now — and nothing more.
 *
 * Deliberately narrow, because a wrong `pass` poisons skill learning:
 * - a pass needs BOTH a passing verify command AND a commit in the episode's
 *   window touching a file the episode named;
 * - no verify command configured, or a failing one, writes nothing at all; a
 *   red suite cannot be attributed to one episode, and a green suite tells us
 *   nothing about an episode whose work never reached a commit;
 * - reconciled outcomes are stamped `source: "reconcile"` with
 *   `userConfirmed: false`, so they can never masquerade as user confirmation.
 *
 * It also does not pretend to produce lessons: a pass without a lesson records
 * the episode and skips skill learning (see `shouldApplySkillLearningFromOutcome`),
 * so closing outcomes is necessary for the flywheel, not sufficient.
 */

export const DEFAULT_RECONCILE_LOOKBACK_DAYS = 30;
export const DEFAULT_RECONCILE_LIMIT = 20;
const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;

export interface ReconcileOptions {
  workspaceRoot: string;
  /** Required to conclude anything: without a verify command we only report. */
  verifyCommand?: string;
  lookbackDays?: number;
  limit?: number;
  verifyTimeoutMs?: number;
  dryRun?: boolean;
}

export type ReconcileUnresolvedReason =
  | "no-verify-command"
  | "verify-failed"
  | "no-git-history"
  | "no-named-files"
  | "no-commit-in-window";

export interface ReconcileEpisodeResult {
  id: string;
  task: string;
  verdict?: "pass";
  namedFiles: string[];
  commits: number;
  unresolvedReason?: ReconcileUnresolvedReason;
}

export interface ReconcileReport {
  candidates: number;
  written: number;
  dryRun: boolean;
  verifyCommand?: string;
  verifyExitCode?: number;
  results: ReconcileEpisodeResult[];
  counts: Record<ReconcileUnresolvedReason | "pass", number>;
  /** Pass without a lesson closes the episode but does not teach a skill. */
  passesWithoutLessons: number;
}

/** Path-looking tokens in the task text: `src/graph/packer.ts`, `docs/a.md#L3`. */
export function extractNamedFiles(texts: readonly string[], workspaceRoot: string): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/[\w.@-]+(?:[\\/][\w.@-]+)+\.\w{1,10}/g)) {
      const rel = match[0].replace(/^\.?\//, "");
      if (rel.includes("..")) continue;
      if (found.has(rel)) continue;
      if (existsSync(join(workspaceRoot, rel))) found.add(rel);
    }
  }
  return [...found].sort();
}

interface WindowCommit {
  sha: string;
  files: Set<string>;
}

function gitCommitsInWindow(
  workspaceRoot: string,
  sinceMs: number,
  untilMs: number
): WindowCommit[] | undefined {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const result = spawnSync(
    "git",
    ["-C", workspaceRoot, "log", `--since=${iso(sinceMs)}`, `--until=${iso(untilMs)}`, "--name-only", "--pretty=format:%H"],
    { encoding: "utf8", timeout: 20_000 }
  );
  if (result.status !== 0) {
    return undefined;
  }
  const commits: WindowCommit[] = [];
  let current: WindowCommit | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (/^[0-9a-f]{40}$/.test(line.trim())) {
      current = { sha: line.trim(), files: new Set() };
      commits.push(current);
    } else if (line.trim() && current) {
      current.files.add(line.trim());
    }
  }
  return commits;
}

function runVerifyCommand(
  workspaceRoot: string,
  command: string,
  timeoutMs: number
): number | undefined {
  // `command` comes from the workspace's own config file (0600), never from the
  // graph, a team package or an agent message.
  const result = spawnSync(command, { shell: true, cwd: workspaceRoot, timeout: timeoutMs });
  if (typeof result.status === "number") return result.status;
  return undefined;
}

function isResolvable(episode: EpisodeRecord): boolean {
  const outcome = episode.outcome;
  return outcome === "pending" || outcome === "human_review";
}

/**
 * Resolve pending episodes against git history and one verify-command run.
 * `writeOutcome` is injected so the caller routes through `reportOutcome` and
 * the existing learning/audit chain runs identically.
 */
export async function reconcileEpisodes(
  client: GraphClient,
  options: ReconcileOptions,
  writeOutcome: (episodeId: string, evidence: OutcomeEvidenceInput) => Promise<boolean>
): Promise<ReconcileReport> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_RECONCILE_LOOKBACK_DAYS;
  const limit = options.limit ?? DEFAULT_RECONCILE_LIMIT;
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  const counts: Record<ReconcileUnresolvedReason | "pass", number> = {
    "no-verify-command": 0,
    "verify-failed": 0,
    "no-git-history": 0,
    "no-named-files": 0,
    "no-commit-in-window": 0,
    pass: 0,
  };
  const report: ReconcileReport = {
    candidates: 0,
    written: 0,
    dryRun: options.dryRun === true,
    results: [],
    counts,
    passesWithoutLessons: 0,
  };
  if (options.verifyCommand) report.verifyCommand = options.verifyCommand;

  const episodes = (await loadAllEpisodes(client)).filter(
    (episode) => isResolvable(episode) && episode.updatedAt >= cutoff
  );
  report.candidates = episodes.length;
  if (episodes.length === 0) return report;

  // One run for the whole pass: a suite is not per-episode, and running it 20
  // times would be slow and would still mean the same thing.
  let verifyExit: number | undefined;
  if (options.verifyCommand) {
    verifyExit = runVerifyCommand(
      options.workspaceRoot,
      options.verifyCommand,
      options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    );
    if (verifyExit !== undefined) report.verifyExitCode = verifyExit;
  }

  for (const episode of episodes.slice(0, limit)) {
    const namedFiles = extractNamedFiles(
      [episode.task, ...(episode.plan ?? []).map((step) => step.description ?? "")],
      options.workspaceRoot
    );
    const result: ReconcileEpisodeResult = {
      id: episode.id,
      task: episode.task.slice(0, 120),
      namedFiles,
      commits: 0,
    };
    report.results.push(result);

    if (!options.verifyCommand) {
      result.unresolvedReason = "no-verify-command";
      counts["no-verify-command"] += 1;
      continue;
    }
    if (verifyExit !== 0) {
      result.unresolvedReason = "verify-failed";
      counts["verify-failed"] += 1;
      continue;
    }
    if (namedFiles.length === 0) {
      result.unresolvedReason = "no-named-files";
      counts["no-named-files"] += 1;
      continue;
    }

    const commits = gitCommitsInWindow(options.workspaceRoot, episode.createdAt, Date.now());
    if (!commits) {
      result.unresolvedReason = "no-git-history";
      counts["no-git-history"] += 1;
      continue;
    }
    const touching = commits.filter((commit) => [...namedFiles].some((file) => commit.files.has(file)));
    result.commits = touching.length;
    if (touching.length === 0) {
      result.unresolvedReason = "no-commit-in-window";
      counts["no-commit-in-window"] += 1;
      continue;
    }

    result.verdict = "pass";
    counts.pass += 1;
    if ((episode.lessons ?? []).length === 0) report.passesWithoutLessons += 1;
    if (report.dryRun) continue;

    const firstCommit = touching[0]?.sha;
    const wrote = await writeOutcome(episode.id, {
      ...(firstCommit ? { commit: firstCommit } : {}),
      testCommand: options.verifyCommand,
      testResult: "pass",
      source: "reconcile",
      userConfirmed: false,
      repository: options.workspaceRoot,
    });
    if (wrote) report.written += 1;
  }

  return report;
}
