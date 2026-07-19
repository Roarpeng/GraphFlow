import type { GraphEdge } from "../core/types";

export interface SkillState {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
  /** Soft-hidden from insights/hints after pruneFailedSkills (toxic fail streak). */
  hidden?: boolean;
}

export interface CompositeSkillState {
  id: string;
  name: string;
  parents: [string, string];
  coOccurCount: number;
  successCount: number;
  failureCount: number;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
}

export type EdgeRelation = GraphEdge["relation"];
export type SkillEdge = { from: string; to: string; relation: EdgeRelation };

export const DEFAULT_COMPOSITE_MIN_COOCCUR = 2;
export const DEFAULT_COMPOSITE_MIN_SUCCESS = 2;
