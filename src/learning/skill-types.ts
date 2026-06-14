import type { GraphEdge } from "../core/types";

export interface EvolutionarySkillNode {
  id: string;
  name: string; // MiniCPM 生成的复合中文名
  parents: [string, string];
  domain: string; // 解决的 C 领域
  description: string; // 合成方法论描述
  score: number;
  uses: number;
  updatedAt: number;
  canaryUses: number;
  canaryPasses: number;
  canaryStatus: 'probation' | 'verified' | 'demoted';
}

export interface SkillState {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
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
