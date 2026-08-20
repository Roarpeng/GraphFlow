import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";
import type { EpisodeRecord } from "./episodic-memory";
import { hasProjectSymbolEvidence } from "./skill-flywheel";
import { parseSkillState, serializeAtomic } from "./skill-store";
import type { SkillState } from "./skill-types";

/**
 * AWM-style workflow skill distilled from a successful multi-step episode.
 * Id is stable across episodes that share the same ordered plan ids, so
 * `plan.skillRefs` can point at `skill:workflow:<hash>`.
 */
export function workflowSkillId(plan: Array<{ id: string }>): string {
  const hash = hashText(
    [...plan.map((step) => step.id)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("|")
  );
  return `skill:workflow:${hash}`;
}

function numberedGuidance(plan: Array<{ id: string; description: string }>): string {
  return plan
    .map((step, index) => `${index + 1}. ${step.description}`.trim())
    .join("\n");
}

function corpusHasSymbolEvidence(episode: EpisodeRecord): boolean {
  const corpus = [episode.task, ...episode.plan.map((step) => step.description)].join("\n");
  return hasProjectSymbolEvidence(corpus);
}

async function listSkillNodes(client: GraphClient): Promise<GraphNode[]> {
  if (typeof client.readSnapshot === "function") {
    return client.readSnapshot().nodes.filter((node) => node.type === "Skill");
  }
  const hits = await client.queryByKeyword("skill");
  return hits.filter((node) => node.type === "Skill" && node.id.startsWith("skill:"));
}

/**
 * Distill a passing multi-step episode plan into a reusable atomic workflow skill.
 * Never auto-promotes to proven — outcomeKind stays `correctable`.
 */
export async function distillWorkflowFromEpisode(
  client: GraphClient,
  episode: EpisodeRecord
): Promise<string | undefined> {
  if (episode.outcome !== "pass" || episode.plan.length < 2) {
    return undefined;
  }

  const id = workflowSkillId(episode.plan);
  const hasSymbolEvidence = corpusHasSymbolEvidence(episode);
  const state: SkillState = {
    id,
    name: `workflow: ${episode.task.slice(0, 60)}`,
    score: 0,
    uses: 0,
    lastOutcome: "pass",
    updatedAt: Date.now(),
    seeded: false,
    outcomeKind: "correctable",
    guidance: numberedGuidance(episode.plan),
    provenance: { source: "local", episodeId: episode.id },
    ...(hasSymbolEvidence ? { hasSymbolEvidence: true } : {}),
  };

  await client.upsertNodes([{ id, type: "Skill", content: serializeAtomic(state) }]);
  await client.upsertEdges([{ from: id, to: episode.id, relation: "derived_from" }]);
  return id;
}

/**
 * SkillJack descendant revoke: soft-hide every atomic skill whose
 * provenance.episodeId matches. Keep the node auditable — never hard-delete,
 * and never rewrite outcomeKind.
 */
export async function quarantineSkillsFromEpisode(
  client: GraphClient,
  episodeId: string
): Promise<{ hidden: number; ids: string[] }> {
  const nodes = await listSkillNodes(client);
  const ids: string[] = [];
  const updates: GraphNode[] = [];

  for (const node of nodes) {
    const state = parseSkillState(node.content);
    if (!state) continue;
    if (state.provenance?.episodeId !== episodeId) continue;
    ids.push(state.id);
    if (state.hidden === true) continue;
    const hidden: SkillState = {
      ...state,
      hidden: true,
      updatedAt: Date.now(),
    };
    updates.push({ id: state.id, type: "Skill", content: serializeAtomic(hidden) });
  }

  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return { hidden: updates.length, ids };
}
