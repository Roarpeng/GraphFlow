import type { GraphEdge, GraphNode, TaskRunResult } from "../core/types";
import type { GraphClient } from "../graph/client-factory";

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

type EdgeRelation = GraphEdge["relation"];
type SkillEdge = { from: string; to: string; relation: EdgeRelation };

const COMPOSITE_MIN_COOCCUR = 2;
const COMPOSITE_MIN_SUCCESS = 2;

export function extractSkillAtoms(task: string): string[] {
  const phrases = task
    .split(/\band\b|,|;/i)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
    .slice(0, 8);

  const tokenSkills = task
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_./-]/g, ""))
    .filter((token) => token.length >= 5)
    .slice(0, 8);

  return dedup([...phrases, ...tokenSkills]);
}

export async function applySkillLearning(
  client: GraphClient,
  task: string,
  run: TaskRunResult
): Promise<void> {
  const skills = extractSkillAtoms(task);
  if (skills.length === 0) {
    return;
  }

  const passed = run.status === "COMPLETED";
  const now = Date.now();
  const nodes: GraphNode[] = [];
  const edges: SkillEdge[] = [];

  for (const skill of skills) {
    const id = skillNodeId(skill);
    const previous = await readSkillState(client, id);
    const next: SkillState = {
      id,
      name: skill,
      score: boundedScore((previous?.score ?? 0) + (passed ? 1 : -1)),
      uses: (previous?.uses ?? 0) + 1,
      lastOutcome: passed ? "pass" : "fail",
      updatedAt: now,
    };

    nodes.push({ id, type: "Skill", content: serializeAtomic(next) });
    edges.push({
      from: id,
      to: `decision:task:${hashText(task)}`,
      relation: "improves",
    });
  }

  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const a = skills[i]!;
      const b = skills[j]!;
      edges.push({
        from: skillNodeId(a),
        to: skillNodeId(b),
        relation: "co_occurs",
      });

      const [n1, n2] = [a, b].sort();
      const compositeId = composeSkillId(n1!, n2!);
      const previous = await loadCompositeSkill(client, compositeId);
      const composite: CompositeSkillState = {
        id: compositeId,
        name: `${n1}+${n2}`,
        parents: [skillNodeId(n1!), skillNodeId(n2!)],
        coOccurCount: (previous?.coOccurCount ?? 0) + 1,
        successCount: (previous?.successCount ?? 0) + (passed ? 1 : 0),
        failureCount: (previous?.failureCount ?? 0) + (passed ? 0 : 1),
        score: 0,
        uses: previous?.uses ?? 0,
        lastOutcome: passed ? "pass" : "fail",
        updatedAt: now,
      };
      composite.score = boundedScore(composite.successCount - composite.failureCount);

      nodes.push({ id: compositeId, type: "Skill", content: serializeComposite(composite) });

      if (compositeGateMet(composite)) {
        edges.push({ from: skillNodeId(n1!), to: compositeId, relation: "prerequisite" });
        edges.push({ from: skillNodeId(n2!), to: compositeId, relation: "prerequisite" });
      }
    }
  }

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));
}

export async function suggestSkillHints(
  client: GraphClient,
  task: string,
  maxHints: number
): Promise<string[]> {
  const atoms = extractSkillAtoms(task);
  const queries = dedup([task.toLowerCase(), ...atoms]).slice(0, 10);
  const resultSets = await Promise.all(queries.map((query) => client.queryByKeyword(query)));

  const skillNodes = dedupNodes(resultSets.flat().filter((node) => node.type === "Skill"));

  const atomicStates: SkillState[] = [];
  const compositeStates: CompositeSkillState[] = [];
  for (const node of skillNodes) {
    const composite = parseCompositeState(node.content);
    if (composite) {
      compositeStates.push(composite);
      continue;
    }
    const atomic = parseSkillState(node.content);
    if (atomic) {
      atomicStates.push(atomic);
    }
  }

  const atomSet = new Set(atoms);
  const eligibleComposites = compositeStates.filter((composite) => {
    if (!compositeGateMet(composite) || composite.score <= 0) {
      return false;
    }
    const [n1, n2] = composite.name.split("+");
    return Boolean(n1 && n2 && atomSet.has(n1) && atomSet.has(n2));
  });

  type Ranked = {
    name: string;
    score: number;
    uses: number;
    isComposite: boolean;
    state?: CompositeSkillState;
  };
  const ranked: Ranked[] = [
    ...eligibleComposites.map((c) => ({
      name: c.name,
      score: c.score,
      uses: c.uses,
      isComposite: true,
      state: c,
    })),
    ...atomicStates.map((a) => ({
      name: a.name,
      score: a.score,
      uses: a.uses,
      isComposite: false,
    })),
  ];

  ranked.sort((a, b) => {
    if (a.isComposite !== b.isComposite) {
      return a.isComposite ? -1 : 1;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.uses !== a.uses) {
      return b.uses - a.uses;
    }
    return a.name.localeCompare(b.name);
  });

  const chosen = ranked.slice(0, maxHints);

  const updates: GraphNode[] = [];
  for (const item of chosen) {
    if (item.isComposite && item.state) {
      const updated: CompositeSkillState = {
        ...item.state,
        uses: item.state.uses + 1,
        updatedAt: Date.now(),
      };
      updates.push({ id: updated.id, type: "Skill", content: serializeComposite(updated) });
    }
  }
  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return chosen.map((item) => item.name);
}

export function composeSkillId(atomA: string, atomB: string): string {
  const [first, second] = [atomA, atomB].sort();
  return `skill:composite:${sanitizeAtom(first!)}__${sanitizeAtom(second!)}`;
}

export async function loadCompositeSkill(
  client: GraphClient,
  id: string
): Promise<CompositeSkillState | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseCompositeState(direct.content) : undefined;
}

function compositeGateMet(composite: CompositeSkillState): boolean {
  return (
    composite.coOccurCount >= COMPOSITE_MIN_COOCCUR &&
    composite.successCount >= COMPOSITE_MIN_SUCCESS &&
    composite.successCount > composite.failureCount
  );
}

function sanitizeAtom(skill: string): string {
  return skill.replace(/[^a-z0-9]+/g, "-");
}

function skillNodeId(skill: string): string {
  return `skill:${sanitizeAtom(skill)}`;
}

function serializeAtomic(state: SkillState): string {
  return JSON.stringify({ kind: "atomic", ...state });
}

function serializeComposite(state: CompositeSkillState): string {
  return JSON.stringify({ kind: "composite", ...state });
}

function parseSkillState(content: string): SkillState | undefined {
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
  } catch {
    return undefined;
  }
}

function parseCompositeState(content: string): CompositeSkillState | undefined {
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
  } catch {
    return undefined;
  }
}

async function readSkillState(client: GraphClient, id: string): Promise<SkillState | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseSkillState(direct.content) : undefined;
}

function dedup(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupNodes(nodes: GraphNode[]): GraphNode[] {
  const map = new Map<string, GraphNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return Array.from(map.values());
}

function boundedScore(score: number): number {
  if (score > 20) {
    return 20;
  }

  if (score < -20) {
    return -20;
  }

  return score;
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function dedupEdges(edges: SkillEdge[]): SkillEdge[] {
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
