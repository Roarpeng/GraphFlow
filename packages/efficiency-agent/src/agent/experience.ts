import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { taskTokens } from "../host/project-facts.js";
import type { TrajectoryRecord } from "../learning/trajectory.js";

/**
 * Experience store (2.x plan §18): one line per finished eff-agent run. It is
 * the efficiency layer's own memory — experience search (§27 step 3), the
 * trajectory source for policy learning, and the tool success history.
 */

export type RunStatus =
  | "completed"
  | "reused"
  | "validation-only"
  | "failed"
  | "budget-exhausted"
  | "unverified"
  | "not-executed"
  | "advisory-only"
  /** The security gate denied (or required approval for) an action before it ran. */
  | "blocked"
  /** The agent wrote outside what the task category / policy permits. */
  | "violation";

export interface ExperienceRecord {
  taskId: string;
  task: string;
  category: string;
  status: RunStatus;
  worker: string;
  reuseMode: "REUSE" | "ADAPT" | "FRESH";
  modelTier: "economy" | "standard" | "heavy";
  rounds: number;
  durationMs: number;
  agentInvocations: number;
  cacheHits: number;
  cacheMisses: number;
  validationPassed: boolean;
  startedAt: string;
  finishedAt: string;
  /** Failing check names / stop reason — the lesson a later run can read. */
  lesson?: string;
}

export interface SimilarExperience {
  record: ExperienceRecord;
  similarity: number;
}

export interface ExperienceStore {
  read(): ExperienceRecord[];
  append(record: ExperienceRecord): void;
}

export function createExperienceStore(path: string): ExperienceStore {
  return {
    read() {
      if (!existsSync(path)) return [];
      const records: ExperienceRecord[] = [];
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as ExperienceRecord;
          if (typeof parsed.task === "string" && typeof parsed.status === "string") records.push(parsed);
        } catch {
          // Skip a corrupt line; the rest of the history stays usable.
        }
      }
      return records;
    },
    append(record) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
    },
  };
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const token of new Set(a)) if (setB.has(token)) inter += 1;
  return inter / (new Set([...a, ...b]).size);
}

/** Past runs whose task text overlaps this one (Jaccard >= floor), best first. */
export function searchExperience(
  task: string,
  history: readonly ExperienceRecord[],
  options: { floor?: number; limit?: number } = {}
): SimilarExperience[] {
  const floor = options.floor ?? 0.5;
  const tokens = taskTokens(task);
  return history
    .map((record) => ({ record, similarity: Number(jaccard(tokens, taskTokens(record.task)).toFixed(3)) }))
    .filter((entry) => entry.similarity >= floor)
    .sort((a, b) => b.similarity - a.similarity || (a.record.finishedAt < b.record.finishedAt ? 1 : -1))
    .slice(0, options.limit ?? 3);
}

const EXECUTED: ReadonlySet<RunStatus> = new Set(["completed", "reused", "failed", "budget-exhausted", "unverified", "violation"]);

/** Executed runs as policy-learner trajectories (advisory/not-executed runs carry no outcome). */
export function toTrajectories(history: readonly ExperienceRecord[]): TrajectoryRecord[] {
  return history
    .filter((record) => EXECUTED.has(record.status))
    .map((record) => ({
      taskId: record.taskId,
      taskCategory: record.category,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      decision: { reuseMode: record.reuseMode, modelTier: record.modelTier },
      rounds: Math.max(1, record.rounds),
      llmCalls: record.agentInvocations,
      toolCalls: record.agentInvocations,
      cacheHits: record.cacheHits,
      cacheMisses: record.cacheMisses,
      validationPassed: record.validationPassed,
      success: record.status === "completed" || record.status === "reused",
      costMs: record.durationMs,
      costTokens: 0,
      ...(record.status === "completed" || record.status === "reused"
        ? {}
        : { failureStage: record.lesson ?? record.status }),
    }));
}
