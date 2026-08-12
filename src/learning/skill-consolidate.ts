/**
 * QM-inspired skill consolidation: explicit, auditable actions only.
 * Heuristic planner — no LLM required. Apply is opt-in and safe (skips unknown ids).
 */

import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { shouldHardDeleteAntiPattern } from "./canary-gate";
import {
  parseSkillState,
  sanitizeAtom,
  serializeAtomic,
  skillNodeId,
} from "./skill-store";
import type { SkillOutcomeKind, SkillState } from "./skill-types";

/** QM-style consolidation verbs — no free-form edits. */
export type ConsolidateActionKind = "UPDATE" | "DELETE" | "ADD" | "NONE";

export interface ConsolidateSkillInput {
  id: string;
  name: string;
  score: number;
  uses: number;
  outcomeKind?: SkillOutcomeKind;
  guidance?: string;
}

export interface ConsolidateCandidate {
  name: string;
  guidance?: string;
  score?: number;
  uses?: number;
  outcomeKind?: SkillOutcomeKind;
}

export interface ConsolidateAction {
  action: ConsolidateActionKind;
  /** Target skill id for UPDATE / DELETE / NONE; generated id for ADD. */
  skillId?: string;
  name?: string;
  /** Fields to write on UPDATE / ADD. */
  patch?: {
    name?: string;
    score?: number;
    uses?: number;
    guidance?: string;
    outcomeKind?: SkillOutcomeKind;
  };
  reason: string;
  /** Related skill ids (e.g. merge duplicates deleted alongside survivor UPDATE). */
  relatedIds?: string[];
}

export interface PlanSkillConsolidationOptions {
  /** Suggested new skills — ADD only when provided; match existing → UPDATE instead. */
  candidates?: ConsolidateCandidate[];
  /** Score at or below this with uses=0 is eligible for DELETE (default -10). */
  veryLowScore?: number;
}

/** Request wrapper for programmatic / CLI dry-run callers. */
export interface ConsolidateRequest {
  skills: ConsolidateSkillInput[];
  options?: PlanSkillConsolidationOptions;
}

export interface ConsolidateResult {
  actions: ConsolidateAction[];
  summary: {
    updates: number;
    deletes: number;
    adds: number;
    none: number;
  };
}

export interface ApplySkillConsolidationResult {
  applied: ConsolidateAction[];
  skipped: Array<{ action: ConsolidateAction; reason: string }>;
}

const DEFAULT_VERY_LOW_SCORE = -10;

/** Normalize skill names for near-duplicate detection (lowercase + hyphen). */
export function normalizeSkillNameKey(name: string): string {
  return sanitizeAtom(name.trim().toLowerCase()).replace(/^-+|-+$/g, "");
}

function summarizeActions(actions: ConsolidateAction[]): ConsolidateResult["summary"] {
  const summary = { updates: 0, deletes: 0, adds: 0, none: 0 };
  for (const action of actions) {
    if (action.action === "UPDATE") summary.updates += 1;
    else if (action.action === "DELETE") summary.deletes += 1;
    else if (action.action === "ADD") summary.adds += 1;
    else summary.none += 1;
  }
  return summary;
}

export function toConsolidateResult(actions: ConsolidateAction[]): ConsolidateResult {
  return { actions, summary: summarizeActions(actions) };
}

function pickSurvivor(group: ConsolidateSkillInput[]): ConsolidateSkillInput {
  return [...group].sort((a, b) => {
    const provenBias = (s: ConsolidateSkillInput) => (s.outcomeKind === "proven" ? 1 : 0);
    return (
      b.uses - a.uses ||
      b.score - a.score ||
      provenBias(b) - provenBias(a) ||
      a.id.localeCompare(b.id)
    );
  })[0]!;
}

function mergeGuidance(...parts: Array<string | undefined>): string | undefined {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const part of parts) {
    const trimmed = part?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(trimmed);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Plan consolidation actions for a skill inventory.
 * Prefer UPDATE (merge / refresh) over DELETE+ADD. Anti-pattern hard-delete
 * follows {@link shouldHardDeleteAntiPattern} (currently always false — soft isolation).
 */
export function planSkillConsolidation(
  skills: ConsolidateSkillInput[],
  options?: PlanSkillConsolidationOptions
): ConsolidateAction[] {
  const veryLowScore = options?.veryLowScore ?? DEFAULT_VERY_LOW_SCORE;
  const actions: ConsolidateAction[] = [];
  const consumed = new Set<string>();

  // 1) MERGE near-duplicate names → UPDATE survivor + DELETE duplicates
  const byKey = new Map<string, ConsolidateSkillInput[]>();
  for (const skill of skills) {
    const key = normalizeSkillNameKey(skill.name);
    if (!key) continue;
    const group = byKey.get(key) ?? [];
    group.push(skill);
    byKey.set(key, group);
  }

  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const survivor = pickSurvivor(group);
    const duplicates = group.filter((s) => s.id !== survivor.id);
    const mergedUses = group.reduce((sum, s) => sum + s.uses, 0);
    const mergedScore = Math.max(...group.map((s) => s.score));
    const mergedGuidance = mergeGuidance(survivor.guidance, ...duplicates.map((d) => d.guidance));
    const outcomeKind =
      group.find((s) => s.outcomeKind === "proven")?.outcomeKind ??
      survivor.outcomeKind ??
      group.find((s) => s.outcomeKind)?.outcomeKind;

    actions.push({
      action: "UPDATE",
      skillId: survivor.id,
      name: survivor.name,
      patch: {
        name: survivor.name,
        score: mergedScore,
        uses: mergedUses,
        ...(mergedGuidance ? { guidance: mergedGuidance } : {}),
        ...(outcomeKind ? { outcomeKind } : {}),
      },
      reason: `merge ${duplicates.length} near-duplicate name(s) into survivor`,
      relatedIds: duplicates.map((d) => d.id),
    });
    consumed.add(survivor.id);

    for (const dup of duplicates) {
      actions.push({
        action: "DELETE",
        skillId: dup.id,
        name: dup.name,
        reason: `duplicate of ${survivor.id} after name normalize`,
        relatedIds: [survivor.id],
      });
      consumed.add(dup.id);
    }
  }

  // 2) DELETE: anti-pattern when policy allows, or unused very-low score
  const hardDeleteAnti = shouldHardDeleteAntiPattern();
  for (const skill of skills) {
    if (consumed.has(skill.id)) continue;

    if (skill.outcomeKind === "anti-pattern" && hardDeleteAnti) {
      actions.push({
        action: "DELETE",
        skillId: skill.id,
        name: skill.name,
        reason: "anti-pattern eligible for hard-delete per canary policy",
      });
      consumed.add(skill.id);
      continue;
    }

    if (skill.uses === 0 && skill.score <= veryLowScore) {
      actions.push({
        action: "DELETE",
        skillId: skill.id,
        name: skill.name,
        reason: `unused skill with very low score (<= ${veryLowScore})`,
      });
      consumed.add(skill.id);
    }
  }

  // 3) ADD candidates (prefer UPDATE when normalized name already exists)
  const existingByKey = new Map<string, ConsolidateSkillInput>();
  for (const skill of skills) {
    if (consumed.has(skill.id) && !actions.some((a) => a.action === "UPDATE" && a.skillId === skill.id)) {
      // deleted — do not treat as existing for ADD match
      continue;
    }
    const key = normalizeSkillNameKey(skill.name);
    if (!key) continue;
    // Prefer survivor / highest-uses entry for the key
    const prev = existingByKey.get(key);
    if (!prev || skill.uses > prev.uses || (skill.uses === prev.uses && skill.score > prev.score)) {
      // Skip if this id was deleted in this plan
      if (actions.some((a) => a.action === "DELETE" && a.skillId === skill.id)) continue;
      existingByKey.set(key, skill);
    }
  }
  // Re-seed from UPDATE survivors so candidate matching prefers them
  for (const action of actions) {
    if (action.action !== "UPDATE" || !action.skillId) continue;
    const key = normalizeSkillNameKey(action.name ?? action.patch?.name ?? "");
    if (!key) continue;
    const base = skills.find((s) => s.id === action.skillId);
    if (!base) continue;
    existingByKey.set(key, {
      ...base,
      score: action.patch?.score ?? base.score,
      uses: action.patch?.uses ?? base.uses,
      ...(action.patch?.guidance !== undefined ? { guidance: action.patch.guidance } : {}),
      ...(action.patch?.outcomeKind !== undefined ? { outcomeKind: action.patch.outcomeKind } : {}),
    });
  }

  for (const candidate of options?.candidates ?? []) {
    const key = normalizeSkillNameKey(candidate.name);
    if (!key) continue;
    const existing = existingByKey.get(key);
    if (existing) {
      // Prefer UPDATE over DELETE+ADD
      const alreadyUpdated = actions.some(
        (a) => a.action === "UPDATE" && a.skillId === existing.id
      );
      if (alreadyUpdated) {
        const update = actions.find((a) => a.action === "UPDATE" && a.skillId === existing.id)!;
        const foldedGuidance = candidate.guidance
          ? mergeGuidance(update.patch?.guidance, candidate.guidance)
          : undefined;
        update.patch = {
          name: update.patch?.name ?? existing.name,
          score:
            candidate.score !== undefined
              ? Math.max(update.patch?.score ?? existing.score, candidate.score)
              : (update.patch?.score ?? existing.score),
          uses: update.patch?.uses ?? existing.uses,
          ...(foldedGuidance ? { guidance: foldedGuidance } : update.patch?.guidance ? { guidance: update.patch.guidance } : {}),
          ...(candidate.outcomeKind
            ? { outcomeKind: candidate.outcomeKind }
            : update.patch?.outcomeKind
              ? { outcomeKind: update.patch.outcomeKind }
              : {}),
        };
        update.reason = `${update.reason}; fold candidate "${candidate.name}" into UPDATE`;
        continue;
      }
      const mergedGuidance = mergeGuidance(existing.guidance, candidate.guidance);
      const mergedOutcome = candidate.outcomeKind ?? existing.outcomeKind;
      actions.push({
        action: "UPDATE",
        skillId: existing.id,
        name: existing.name,
        patch: {
          name: existing.name,
          score: Math.max(existing.score, candidate.score ?? existing.score),
          uses: Math.max(existing.uses, candidate.uses ?? existing.uses),
          ...(mergedGuidance ? { guidance: mergedGuidance } : {}),
          ...(mergedOutcome ? { outcomeKind: mergedOutcome } : {}),
        },
        reason: `prefer UPDATE over ADD for candidate matching "${existing.name}"`,
      });
      continue;
    }

    const id = skillNodeId(candidate.name);
    actions.push({
      action: "ADD",
      skillId: id,
      name: candidate.name,
      patch: {
        name: candidate.name,
        score: candidate.score ?? 0,
        uses: candidate.uses ?? 0,
        ...(candidate.guidance ? { guidance: candidate.guidance } : {}),
        ...(candidate.outcomeKind ? { outcomeKind: candidate.outcomeKind } : {}),
      },
      reason: "candidate not present in skill inventory",
    });
  }

  return actions;
}

async function listSkillNodes(client: GraphClient): Promise<GraphNode[]> {
  if (client.readSnapshot) {
    return client.readSnapshot().nodes.filter((node) => node.type === "Skill");
  }
  const hits = await client.queryByKeyword("skill");
  return hits.filter((node) => node.type === "Skill");
}

/**
 * Apply UPDATE / DELETE (and ADD) actions to Skill nodes.
 * Unknown ids are skipped. DELETE falls back to soft-hide when deleteNode is missing.
 */
export async function applySkillConsolidation(
  graphClient: GraphClient,
  actions: ConsolidateAction[]
): Promise<ApplySkillConsolidationResult> {
  const applied: ConsolidateAction[] = [];
  const skipped: Array<{ action: ConsolidateAction; reason: string }> = [];
  const nodes = await listSkillNodes(graphClient);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const action of actions) {
    if (action.action === "NONE") {
      skipped.push({ action, reason: "NONE is a no-op" });
      continue;
    }

    if (action.action === "ADD") {
      const name = action.patch?.name ?? action.name;
      if (!name?.trim()) {
        skipped.push({ action, reason: "ADD missing name" });
        continue;
      }
      const id = action.skillId ?? skillNodeId(name);
      if (byId.has(id)) {
        skipped.push({ action, reason: `skill already exists: ${id}` });
        continue;
      }
      const state: SkillState = {
        id,
        name,
        score: action.patch?.score ?? 0,
        uses: action.patch?.uses ?? 0,
        lastOutcome: "pass",
        updatedAt: Date.now(),
        ...(action.patch?.guidance ? { guidance: action.patch.guidance } : {}),
        ...(action.patch?.outcomeKind ? { outcomeKind: action.patch.outcomeKind } : {}),
      };
      await graphClient.upsertNodes([{ id, type: "Skill", content: serializeAtomic(state) }]);
      byId.set(id, { id, type: "Skill", content: serializeAtomic(state) });
      applied.push(action);
      continue;
    }

    const id = action.skillId;
    if (!id) {
      skipped.push({ action, reason: "missing skillId" });
      continue;
    }
    const node = byId.get(id);
    if (!node) {
      skipped.push({ action, reason: `unknown skill id: ${id}` });
      continue;
    }

    if (action.action === "DELETE") {
      if (graphClient.deleteNode) {
        await graphClient.deleteNode(id);
        byId.delete(id);
      } else {
        const atomic = parseSkillState(node.content);
        if (!atomic) {
          skipped.push({ action, reason: `unparseable skill for soft-hide: ${id}` });
          continue;
        }
        const hidden: SkillState = {
          ...atomic,
          hidden: true,
          updatedAt: Date.now(),
        };
        await graphClient.upsertNodes([{ id, type: "Skill", content: serializeAtomic(hidden) }]);
        byId.set(id, { id, type: "Skill", content: serializeAtomic(hidden) });
      }
      applied.push(action);
      continue;
    }

    // UPDATE
    const atomic = parseSkillState(node.content);
    if (!atomic) {
      skipped.push({ action, reason: `unparseable skill for UPDATE: ${id}` });
      continue;
    }
    const next: SkillState = {
      ...atomic,
      name: action.patch?.name ?? atomic.name,
      score: action.patch?.score ?? atomic.score,
      uses: action.patch?.uses ?? atomic.uses,
      updatedAt: Date.now(),
      ...(action.patch?.guidance !== undefined
        ? { guidance: action.patch.guidance }
        : atomic.guidance
          ? { guidance: atomic.guidance }
          : {}),
      ...(action.patch?.outcomeKind !== undefined
        ? { outcomeKind: action.patch.outcomeKind }
        : atomic.outcomeKind
          ? { outcomeKind: atomic.outcomeKind }
          : {}),
    };
    await graphClient.upsertNodes([{ id, type: "Skill", content: serializeAtomic(next) }]);
    byId.set(id, { id, type: "Skill", content: serializeAtomic(next) });
    applied.push(action);
  }

  return { applied, skipped };
}

/** Convenience: plan from a ConsolidateRequest. */
export function planFromRequest(request: ConsolidateRequest): ConsolidateResult {
  return toConsolidateResult(planSkillConsolidation(request.skills, request.options));
}
