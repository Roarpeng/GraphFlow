import { createHash } from "node:crypto";
import type { CollectedProjectFacts } from "../host/project-facts.js";

/**
 * Project Twin facts with provenance (spec §13): every fact names where it
 * came from (source + the command/file in `provenance`), when it was observed,
 * how far it may be trusted, and a content hash. Pure: the host collects, this
 * module only shapes. Real build/test observations override older knowledge.
 */

export type FactSource = "graph" | "git" | "package.json" | "lockfile" | "build" | "test" | "experience";

export interface ProjectFact {
  key: string;
  value: string;
  source: FactSource;
  observedAt: string;
  /** Expiry: once this instant is in the past the fact is stale. */
  validAt?: string;
  confidence: number;
  provenance: string;
  hash: string;
}

export interface BuildProjectFactsOptions {
  now: number;
  graphVersion?: string;
  /** When set, every built fact gets validAt = now + ttlMs. */
  ttlMs?: number;
}

const CONFIDENCE: Record<FactSource, number> = {
  git: 1.0,
  lockfile: 1.0,
  build: 1.0,
  test: 1.0,
  "package.json": 0.95,
  graph: 0.8,
  experience: 0.6,
};

const BUILD_CHECK = /build|tsc|typecheck|type-check|compile/i;

export function factHash(key: string, value: string): string {
  return createHash("sha256").update(key + value).digest("hex").slice(0, 16);
}

const byKey = (a: ProjectFact, b: ProjectFact): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const timeOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

export function buildProjectFacts(collected: CollectedProjectFacts, options: BuildProjectFactsOptions): ProjectFact[] {
  const observedAt = new Date(options.now).toISOString();
  const validAt = options.ttlMs !== undefined ? new Date(options.now + options.ttlMs).toISOString() : undefined;
  const facts: ProjectFact[] = [];
  const add = (key: string, value: string, source: FactSource, provenance: string): void => {
    facts.push({
      key,
      value,
      source,
      observedAt,
      ...(validAt !== undefined ? { validAt } : {}),
      confidence: CONFIDENCE[source],
      provenance,
      hash: factHash(key, value),
    });
  };

  const { projectState, twinFacts } = collected;
  if (projectState.gitHead !== undefined) add("git.head", projectState.gitHead, "git", "git rev-parse HEAD");
  if (projectState.workingTreeHash !== undefined) {
    add("git.workingTree", projectState.workingTreeHash, "git", "sha256(git status --porcelain)");
  }
  if (collected.isGitRepo) {
    add("git.recentCommits", String(twinFacts.recentCommits.length), "git", "git log --oneline -10");
  }

  const pkg = twinFacts.packageJson;
  if (pkg?.name !== undefined) add("package.name", pkg.name, "package.json", "package.json#name");
  for (const [name, command] of Object.entries(pkg?.scripts ?? {})) {
    add(`package.scripts.${name}`, command, "package.json", `package.json#scripts.${name}`);
  }

  if (projectState.dependencyLockHash !== undefined) {
    const lockName = projectState.dependencyLockHash.split(":")[0] ?? "lockfile";
    add("lockfile", projectState.dependencyLockHash, "lockfile", `sha256(${lockName})`);
  }

  if (options.graphVersion !== undefined) {
    add("graph.version", options.graphVersion, "graph", "graphflow-out graph artifact (name:size:mtime)");
  }
  add(
    "files.count",
    String(twinFacts.fileMap.length),
    "git",
    "git ls-files --cached --others --exclude-standard"
  );
  add(
    "files.relevant",
    collected.relevantFiles.join(","),
    "graph",
    "rankRelevantFiles(task, git ls-files, exported symbols)"
  );

  return facts.sort(byKey);
}

export function observeValidation(
  facts: ProjectFact[],
  checks: Array<{ name: string; passed: boolean }>,
  now: number
): ProjectFact[] {
  const observedAt = new Date(now).toISOString();
  const observed = new Map<string, ProjectFact>();
  for (const check of checks) {
    const source: FactSource = BUILD_CHECK.test(check.name) ? "build" : "test";
    const key = `${source}.${check.name}`;
    const value = check.passed ? "passed" : "failed";
    observed.set(key, {
      key,
      value,
      source,
      observedAt,
      confidence: CONFIDENCE[source],
      provenance: `validation check "${check.name}"`,
      hash: factHash(key, value),
    });
  }
  return [...facts.filter((fact) => !observed.has(fact.key)), ...observed.values()].sort(byKey);
}

export function mergeFacts(previous: ProjectFact[], fresh: ProjectFact[]): ProjectFact[] {
  const merged = new Map<string, ProjectFact>();
  for (const fact of previous) {
    const existing = merged.get(fact.key);
    if (existing === undefined || timeOf(fact.observedAt) >= timeOf(existing.observedAt)) merged.set(fact.key, fact);
  }
  for (const fact of fresh) {
    const existing = merged.get(fact.key);
    if (existing === undefined || timeOf(fact.observedAt) >= timeOf(existing.observedAt)) merged.set(fact.key, fact);
  }
  return [...merged.values()].sort(byKey);
}

export function isStale(fact: ProjectFact, now: number): boolean {
  if (fact.validAt === undefined) return false;
  const validUntil = Date.parse(fact.validAt);
  return !Number.isFinite(validUntil) || validUntil < now;
}

export function staleFacts(facts: ProjectFact[], now: number): ProjectFact[] {
  return facts.filter((fact) => isStale(fact, now));
}
