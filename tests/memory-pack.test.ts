import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import { validateConfig } from "../src/config/loader";
import {
  collectMemoryPackFromNodes,
  exportExperienceMemoryPack,
  formatEpisodesMarkdown,
  formatSkillsMarkdown,
} from "../src/graph/memory-pack";

const root = mkdtempSync(join(tmpdir(), "graphflow-memory-pack-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function skillNode(partial: {
  name: string;
  score?: number;
  uses?: number;
  outcomeKind?: string;
  guidance?: string;
  hidden?: boolean;
}): GraphNode {
  return {
    id: `skill:${partial.name}`,
    type: "Skill",
    content: JSON.stringify({
      id: `skill:${partial.name}`,
      name: partial.name,
      score: partial.score ?? 10,
      uses: partial.uses ?? 1,
      lastOutcome: "pass",
      updatedAt: 1,
      ...(partial.outcomeKind ? { outcomeKind: partial.outcomeKind } : {}),
      ...(partial.guidance ? { guidance: partial.guidance } : {}),
      ...(partial.hidden ? { hidden: true } : {}),
    }),
  };
}

function episodeNode(partial: {
  id: string;
  task: string;
  outcome: string;
  lessons?: string[];
  updatedAt: number;
}): GraphNode {
  return {
    id: partial.id,
    type: "Decision",
    content: partial.task,
    metadata: {
      kind: "episode",
      record: JSON.stringify({
        id: partial.id,
        task: partial.task,
        outcome: partial.outcome,
        lessons: partial.lessons ?? [],
        updatedAt: partial.updatedAt,
      }),
    },
  };
}

describe("experience memory pack", () => {
  it("collects skills and recent episodes from nodes", () => {
    const nodes: GraphNode[] = [
      skillNode({
        name: "keep-steps-small",
        score: 40,
        uses: 3,
        outcomeKind: "proven",
        guidance: "Prefer small DAG steps",
      }),
      skillNode({ name: "hidden-skill", hidden: true, outcomeKind: "anti-pattern" }),
      episodeNode({
        id: "episode:old",
        task: "old task",
        outcome: "fail",
        updatedAt: 100,
      }),
      episodeNode({
        id: "episode:new",
        task: "refactor planner module and add regression tests for budget",
        outcome: "pass",
        lessons: ["keep steps small", "report outcome"],
        updatedAt: 200,
      }),
      {
        id: "file:src/a.ts",
        type: "File",
        content: "export const a = 1",
      },
    ];

    const pack = collectMemoryPackFromNodes(nodes, { episodeLimit: 1 });
    expect(pack.skills).toHaveLength(1);
    expect(pack.skills[0]?.name).toBe("keep-steps-small");
    expect(pack.skills[0]?.outcomeKind).toBe("proven");
    expect(pack.skills[0]?.guidance).toContain("small DAG");
    expect(pack.episodes).toHaveLength(1);
    expect(pack.episodes[0]?.id).toBe("episode:new");
    expect(pack.episodes[0]?.lessons).toEqual(["keep steps small", "report outcome"]);
  });

  it("formats markdown tables and episode sections", () => {
    const skillsMd = formatSkillsMarkdown([
      {
        name: "foo",
        score: 12,
        uses: 2,
        outcomeKind: "correctable",
        guidance: "bar",
      },
    ]);
    expect(skillsMd).toContain("| foo | 12 | 2 | correctable | bar |");

    const episodesMd = formatEpisodesMarkdown([
      {
        id: "episode:1",
        task: "do the thing",
        outcome: "pass",
        lessons: ["lesson-a"],
        updatedAt: 0,
      },
    ]);
    expect(episodesMd).toContain("## episode:1");
    expect(episodesMd).toContain("**Outcome:** pass");
    expect(episodesMd).toContain("lesson-a");
  });

  it("writes README/skills/episodes under the output directory", () => {
    const config = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        workspaceRoot: root,
        transport: "file",
        graphStorePath: join(root, "graph.json"),
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        exportPath: join(root, "learning.jsonl"),
      },
      embeddingPolicy: { enabled: false },
    });

    const outDir = join(root, "memory-pack-out");
    const result = exportExperienceMemoryPack(config, outDir, {
      clientSnapshot: {
        nodes: [
          skillNode({
            name: "use-context-first",
            score: 20,
            uses: 5,
            outcomeKind: "proven",
            guidance: "Call graphflow_context before scanning",
          }),
          episodeNode({
            id: "episode:pack",
            task: "document context contract",
            outcome: "pass",
            lessons: ["ship markdown pack"],
            updatedAt: Date.now(),
          }),
        ],
      },
    });

    expect(result.path).toBe(outDir);
    expect(result.skillCount).toBe(1);
    expect(result.episodeCount).toBe(1);
    expect(result.files).toEqual(["README.md", "skills.md", "episodes.md", "dialogues.md"]);

    const readme = readFileSync(join(outDir, "README.md"), "utf8");
    const skills = readFileSync(join(outDir, "skills.md"), "utf8");
    const episodes = readFileSync(join(outDir, "episodes.md"), "utf8");
    const dialogues = readFileSync(join(outDir, "dialogues.md"), "utf8");
    expect(readme).toContain("experience memory pack");
    expect(skills).toContain("use-context-first");
    expect(episodes).toContain("document context contract");
    expect(episodes).toContain("ship markdown pack");
    expect(dialogues).toContain("No dialogue-turn");
  });
});
