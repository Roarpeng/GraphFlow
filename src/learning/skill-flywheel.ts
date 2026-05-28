import type { TaskRunResult } from "../core/types";
import type { GraphClient } from "../graph/client-factory";

export interface SkillState {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
}

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
  const nodes = [] as Array<{ id: string; type: "Skill"; content: string }>;
  const edges = [] as Array<{ from: string; to: string; relation: "co_occurs" | "improves" }>;

  for (const skill of skills) {
    const id = skillNodeId(skill);
    const previous = await readSkillState(client, id);
    const next: SkillState = {
      id,
      name: skill,
      score: boundedScore((previous?.score ?? 0) + (passed ? 1 : -1)),
      uses: (previous?.uses ?? 0) + 1,
      lastOutcome: passed ? "pass" : "fail",
      updatedAt: Date.now(),
    };

    nodes.push({ id, type: "Skill", content: JSON.stringify(next) });
    edges.push({
      from: id,
      to: `decision:task:${hashText(task)}`,
      relation: "improves",
    });
  }

  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      edges.push({
        from: skillNodeId(skills[i]!),
        to: skillNodeId(skills[j]!),
        relation: "co_occurs",
      });
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
  const queries = dedup([task.toLowerCase(), ...extractSkillAtoms(task)]).slice(0, 10);
  const resultSets = await Promise.all(queries.map((query) => client.queryByKeyword(query)));

  const states = dedupById(
    resultSets
      .flat()
      .filter((node) => node.type === "Skill")
      .map((node) => parseSkillState(node.content))
      .filter((state): state is SkillState => Boolean(state))
  );

  return states
    .sort((a, b) => b.score - a.score || b.uses - a.uses || a.name.localeCompare(b.name))
    .slice(0, maxHints)
    .map((state) => state.name);
}

function skillNodeId(skill: string): string {
  return `skill:${skill.replace(/[^a-z0-9]+/g, "-")}`;
}

function parseSkillState(content: string): SkillState | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<SkillState>;
    if (!parsed.id || !parsed.name) {
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

async function readSkillState(client: GraphClient, id: string): Promise<SkillState | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseSkillState(direct.content) : undefined;
}

function dedup(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupById(states: SkillState[]): SkillState[] {
  const map = new Map<string, SkillState>();
  for (const state of states) {
    map.set(state.id, state);
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

function dedupEdges(
  edges: Array<{ from: string; to: string; relation: "co_occurs" | "improves" }>
): Array<{ from: string; to: string; relation: "co_occurs" | "improves" }> {
  const seen = new Set<string>();
  const result: Array<{ from: string; to: string; relation: "co_occurs" | "improves" }> = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.relation}|${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}
