import type { GraphEdge } from "../core/types";

/**
 * P0-2 outcome taxonomy for learned skills. Replaces the single pass/fail score
 * semantics with a four-way classification:
 *
 * - proven:      symbol evidence + enough observations (>= 2 uses or a linked
 *                successful outcome). Only this class accrues positive score.
 * - correctable: symbol evidence present but not yet proven. Never sinks score.
 * - anti-pattern: repeated failures with symbol evidence. The ONLY class that
 *                accrues negative score.
 * - noise:       no symbol evidence (generic bare tokens like "update"/"readme").
 *                Never persisted as a node; pruned on load if already present.
 */
export type SkillOutcomeKind = "proven" | "correctable" | "anti-pattern" | "noise";

/**
 * 技能来源元数据（记忆投毒防护，P1-3）：
 * - local:  本地学习/策划产生（旧数据无 provenance 字段时按 local 处理）。
 * - sync:   经团队 skill sync / import 入库的外部技能，初始分类不得为
 *           proven，须经本地成功使用后才可晋升。
 * - import: 技能包导入（与 sync 同属外部来源，入库时统一标记为 sync）。
 */
export interface SkillProvenance {
  source: "local" | "sync" | "import";
  originRepo?: string;
  capturedAt?: string;
  episodeId?: string;
}

/** 归一化外部输入的 provenance：非法值回退 local，仅保留合法字段。 */
export function normalizeSkillProvenance(
  value: unknown
): SkillProvenance | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<SkillProvenance>;
  const source =
    raw.source === "local" || raw.source === "sync" || raw.source === "import"
      ? raw.source
      : "local";
  return {
    source,
    ...(typeof raw.originRepo === "string" && raw.originRepo ? { originRepo: raw.originRepo } : {}),
    ...(typeof raw.capturedAt === "string" && raw.capturedAt ? { capturedAt: raw.capturedAt } : {}),
    ...(typeof raw.episodeId === "string" && raw.episodeId ? { episodeId: raw.episodeId } : {}),
  };
}

export interface SkillState {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
  /** Soft-hidden from insights/hints after pruneFailedSkills (toxic fail streak). */
  hidden?: boolean;
  lastDecayedAt?: number;
  /** Extraction gate: candidate referenced project symbols (file/function/class paths). */
  hasSymbolEvidence?: boolean;
  /** A successful outcome linked to this skill via the episode outcome loop. */
  linkedSuccess?: boolean;
  /** Consecutive failure count; classified anti-pattern at >= 2. */
  failStreak?: number;
  /** Curated baseline written by seedInitialSkills — never pruned as noise. */
  seeded?: boolean;
  /** Outcome taxonomy classification (persisted for observability). */
  outcomeKind?: SkillOutcomeKind;
  /** 来源元数据；缺失按 local 处理（向后兼容旧数据）。 */
  provenance?: SkillProvenance;
  /**
   * Explicit canary validate hook (team-memory security).
   * When true, external sync skills may promote to proven without waiting
   * for DEFAULT_CANARY_LOCAL_SUCCESSES local applications.
   */
  canaryValidated?: boolean;
  /**
   * Optional free-text guidance refined by SkillOpt-lite from lessons/outcomes.
   * Not required for scoring; used as agent-facing hints when present.
   */
  guidance?: string;
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
  /** Extraction gate: candidate referenced project symbols. */
  hasSymbolEvidence?: boolean;
  /** Curated baseline written by seedInitialSkills — never pruned as noise. */
  seeded?: boolean;
  /** Outcome taxonomy classification (persisted for observability). */
  outcomeKind?: SkillOutcomeKind;
  /** 来源元数据；缺失按 local 处理（向后兼容旧数据）。 */
  provenance?: SkillProvenance;
  /** Explicit canary validate hook for external composite skills. */
  canaryValidated?: boolean;
}

export type EdgeRelation = GraphEdge["relation"];
export type SkillEdge = { from: string; to: string; relation: EdgeRelation };

export const DEFAULT_COMPOSITE_MIN_COOCCUR = 2;
export const DEFAULT_COMPOSITE_MIN_SUCCESS = 2;
