import { logger } from "../utils/logger";
import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import type {
  SkillState,
  CompositeSkillState,
  EvolutionarySkillNode,
  SkillEdge,
} from "./skill-types";
import {
  DEFAULT_COMPOSITE_MIN_COOCCUR,
  DEFAULT_COMPOSITE_MIN_SUCCESS,
} from "./skill-types";

export function sanitizeAtom(skill: string): string {
  return skill.replace(/[^a-z0-9]+/g, "-");
}

export function skillNodeId(skill: string): string {
  return `skill:${sanitizeAtom(skill)}`;
}

export function serializeAtomic(state: SkillState): string {
  return JSON.stringify({ kind: "atomic", ...state });
}

export function serializeComposite(state: CompositeSkillState): string {
  return JSON.stringify({ kind: "composite", ...state });
}

export function parseSkillState(content: string): SkillState | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<SkillState> & { kind?: string };
    if (!parsed.id || !parsed.name) {
      return undefined;
    }
    if (parsed.kind && parsed.kind !== "atomic") {
      return undefined;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch (error) {
    logger.error({ error }, "Caught error");
    return undefined;
  }
}

export function parseCompositeState(content: string): CompositeSkillState | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<CompositeSkillState> & { kind?: string };
    if (parsed.kind !== "composite" || !parsed.id || !parsed.name || !parsed.parents) {
      return undefined;
    }
    const parents = parsed.parents;
    if (!Array.isArray(parents) || parents.length !== 2) {
      return undefined;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      parents: [parents[0]!, parents[1]!],
      coOccurCount: parsed.coOccurCount ?? 0,
      successCount: parsed.successCount ?? 0,
      failureCount: parsed.failureCount ?? 0,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch (error) {
    logger.error({ error }, "Caught error");
    return undefined;
  }
}

export function parseEvolutionState(content: string): EvolutionarySkillNode | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<EvolutionarySkillNode> & { kind?: string };
    if (parsed.kind !== "evolution" || !parsed.id || !parsed.name || !parsed.parents) {
      return undefined;
    }
    const parents = parsed.parents;
    if (!Array.isArray(parents) || parents.length !== 2) {
      return undefined;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      parents: [parents[0]!, parents[1]!],
      domain: parsed.domain || "",
      description: parsed.description || "",
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      updatedAt: parsed.updatedAt ?? 0,
      canaryUses: parsed.canaryUses ?? 0,
      canaryPasses: parsed.canaryPasses ?? 0,
      canaryStatus: parsed.canaryStatus ?? 'probation',
    };
  } catch (error) {
    logger.error({ error }, "Caught error");
    return undefined;
  }
}

export async function readSkillState(client: GraphClient, id: string): Promise<SkillState | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseSkillState(direct.content) : undefined;
}

export async function loadCompositeSkill(
  client: GraphClient,
  id: string
): Promise<CompositeSkillState | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseCompositeState(direct.content) : undefined;
}

export async function loadEvolutionSkill(
  client: GraphClient,
  id: string
): Promise<EvolutionarySkillNode | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseEvolutionState(direct.content) : undefined;
}

export function composeSkillId(atomA: string, atomB: string): string {
  const [first, second] = [atomA, atomB].sort();
  return `skill:composite:${sanitizeAtom(first!)}__${sanitizeAtom(second!)}`;
}

export function compositeGateMet(composite: CompositeSkillState): boolean {
  const minCoOccur = Number(process.env.GRAPHFLOW_SKILL_EVOLVE_MIN_COOCCUR ?? DEFAULT_COMPOSITE_MIN_COOCCUR);
  const minSuccess = Number(process.env.GRAPHFLOW_SKILL_EVOLVE_MIN_SUCCESS ?? DEFAULT_COMPOSITE_MIN_SUCCESS);
  return (
    composite.coOccurCount >= (Number.isFinite(minCoOccur) ? minCoOccur : DEFAULT_COMPOSITE_MIN_COOCCUR) &&
    composite.successCount >= (Number.isFinite(minSuccess) ? minSuccess : DEFAULT_COMPOSITE_MIN_SUCCESS) &&
    composite.successCount > composite.failureCount
  );
}

export function boundedScore(score: number): number {
  if (score > 20) {
    return 20;
  }

  if (score < -20) {
    return -20;
  }

  return score;
}

export function dedup(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function dedupNodes(nodes: GraphNode[]): GraphNode[] {
  const map = new Map<string, GraphNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return Array.from(map.values());
}

export function dedupEdges(edges: SkillEdge[]): SkillEdge[] {
  const seen = new Set<string>();
  const result: SkillEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.relation}|${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}
