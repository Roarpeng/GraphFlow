import { extractSymbolCandidates } from "../graph/symbol-extract";
import type { SkillOutcomeKind, SkillState } from "./skill-types";

export type FreshnessLevel = "fresh" | "watch" | "stale" | "unknown";

export interface SkillFreshness {
  skillId: string;
  name: string;
  level: FreshnessLevel;
  /** staleRefs / totalRefs in [0,1]; 0 when the skill carries no resolvable refs. */
  driftScore: number;
  totalRefs: number;
  resolvedRefs: number;
  staleRefs: string[];
  reason: string;
}

export interface FreshnessOptions {
  watchThreshold?: number;
  staleThreshold?: number;
}

export const DEFAULT_WATCH_THRESHOLD = 0.2;
export const DEFAULT_STALE_THRESHOLD = 0.5;

export const FRESHNESS_ENV = "GRAPHFLOW_FRESHNESS";
export const FRESHNESS_DOWNGRADE_ENV = "GRAPHFLOW_FRESHNESS_DOWNGRADE";

function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return !(normalized === "" || normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no" || normalized === "disabled");
}

export function isFreshnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[FRESHNESS_ENV]);
}

export function isFreshnessDowngradeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[FRESHNESS_DOWNGRADE_ENV]);
}

export function skillTextCorpus(skill: SkillState): string {
  const playbook = (skill.playbook ?? []).map((bullet) => bullet.text).join("\n");
  return [skill.guidance ?? "", skill.description ?? "", playbook].filter((part) => part.length > 0).join("\n");
}

export function extractFreshnessRefs(skill: SkillState): string[] {
  const refs = extractSymbolCandidates(skillTextCorpus(skill));
  return Array.from(new Set(refs));
}

/**
 * The freshness oracle: a skill is stale when the symbols it was learned from
 * no longer resolve in the code graph. Symbol node ids embed a content hash, so
 * a code change retires the id and the reference stops resolving — a signal no
 * vector-backed memory store can produce without a code graph.
 */
export function assessSkillFreshness(
  skill: SkillState,
  resolves: (ref: string) => boolean,
  options: FreshnessOptions = {}
): SkillFreshness {
  const watchThreshold = options.watchThreshold ?? DEFAULT_WATCH_THRESHOLD;
  const staleThreshold = options.staleThreshold ?? DEFAULT_STALE_THRESHOLD;
  const refs = extractFreshnessRefs(skill);
  const staleRefs: string[] = [];
  let resolvedRefs = 0;
  for (const ref of refs) {
    if (resolves(ref)) resolvedRefs += 1;
    else staleRefs.push(ref);
  }

  const totalRefs = refs.length;
  if (totalRefs === 0) {
    return {
      skillId: skill.id,
      name: skill.name,
      level: "unknown",
      driftScore: 0,
      totalRefs: 0,
      resolvedRefs: 0,
      staleRefs: [],
      reason: "no code refs in guidance/playbook — freshness cannot be judged from the graph",
    };
  }

  const driftScore = staleRefs.length / totalRefs;
  const level: FreshnessLevel = driftScore >= staleThreshold ? "stale" : driftScore >= watchThreshold ? "watch" : "fresh";
  const reason =
    level === "stale"
      ? `${staleRefs.length}/${totalRefs} learned refs no longer resolve — the code moved under this skill`
      : level === "watch"
        ? `${staleRefs.length}/${totalRefs} learned refs no longer resolve — re-canary advised`
        : `all ${totalRefs} learned refs still resolve`;

  return { skillId: skill.id, name: skill.name, level, driftScore, totalRefs, resolvedRefs, staleRefs, reason };
}

/**
 * Build a ref resolver from graph nodes. Symbol node ids embed a content hash
 * (`symbol:<path>:<name>:<hash>`), so a ref that no longer matches any node id
 * or label means the code it was learned from has moved.
 */
export function buildRefResolver(
  nodes: ReadonlyArray<{ id: string; type?: string; label?: string }>
): (ref: string) => boolean {
  const index = new Set<string>();
  const add = (value: string | undefined): void => {
    if (typeof value === "string" && value.trim()) index.add(value.trim().toLowerCase());
  };
  for (const node of nodes) {
    add(node.label);
    if (node.id.startsWith("symbol:")) {
      // symbol:<path>:<name>:<hash> — index both the name and the path.
      const parts = node.id.split(":");
      add(parts[parts.length - 2]);
      add(parts.slice(1, -2).join(":"));
    } else if (node.id.startsWith("file:")) {
      add(node.id.slice("file:".length));
    } else {
      add(node.id);
    }
  }
  return (ref: string): boolean => {
    const needle = ref.trim().toLowerCase();
    if (!needle) return false;
    if (index.has(needle)) return true;
    // A bare file path may have been recorded relative to the repo root.
    for (const candidate of index) {
      if (candidate.endsWith(`/${needle}`)) return true;
    }
    return false;
  };
}

export interface FreshnessPolicyInput {
  level: FreshnessLevel;
  outcomeKind?: SkillOutcomeKind;
  canaryValidated?: boolean;
}

export interface FreshnessDecision {
  downgrade: boolean;
  to: SkillOutcomeKind;
  reason: string;
}

/**
 * Only a `proven` skill whose refs have gone stale loses its class. `watch`
 * never demotes on its own, canary-validated skills are held, and skills we
 * could not judge keep their current class.
 */
export function evaluateFreshnessPolicy(input: FreshnessPolicyInput): FreshnessDecision {
  const current: SkillOutcomeKind = input.outcomeKind ?? "correctable";
  if (input.level === "stale" && current === "proven" && input.canaryValidated !== true) {
    return {
      downgrade: true,
      to: "correctable",
      reason: "proven skill's learned refs no longer resolve in the graph — re-canary to regain proven",
    };
  }
  return { downgrade: false, to: current, reason: `freshness level '${input.level}' leaves class '${current}' unchanged` };
}
