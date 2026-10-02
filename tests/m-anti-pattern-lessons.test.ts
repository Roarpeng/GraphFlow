import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  recordEpisode,
  updateEpisodeOutcome,
  type EpisodeRecord,
} from "../src/learning/episodic-memory";
import {
  ANTI_PATTERN_LESSON_KIND,
  suggestSkillConditionHints,
} from "../src/learning/skill-flywheel";
import type { GraphNode } from "../src/core/types";

interface LessonNodeRecord {
  lesson: string;
  taskKey: string;
  symbolRefs: string[];
  failCount: number;
  episodeIds: string[];
  updatedAt: number;
  resolvedAt?: number;
}

function lessonNodes(client: GraphifyClient): GraphNode[] {
  return client
    .snapshot()
    .nodes.filter((node) => node.metadata?.kind === ANTI_PATTERN_LESSON_KIND);
}

function parseLessonNode(node: GraphNode): LessonNodeRecord {
  const parsed = JSON.parse(node.content) as LessonNodeRecord;
  expect(parsed.lesson.length).toBeGreaterThan(0);
  return parsed;
}

async function reportOutcome(
  client: GraphifyClient,
  task: string,
  outcome: "pass" | "fail",
  lessons?: string[]
): Promise<EpisodeRecord> {
  const rec = await recordEpisode(client, {
    task,
    plan: [],
    outcome: "pending",
    keyDecisions: [],
    lessons: [],
    attempts: 1,
  });
  await updateEpisodeOutcome(client, rec.id, outcome, lessons);
  return rec;
}

describe("U5 negative knowledge base (anti-pattern lessons)", () => {
  it("same lesson failing twice → one lesson node with failCount=2, injected with evidence count", async () => {
    const client = new GraphifyClient();
    const task = "harden token budget enforcement in planner.ts";
    const lesson =
      "never widen the budget cap inside planner.ts without updating its tests";

    const first = await reportOutcome(client, task, "fail", [lesson]);
    const second = await reportOutcome(client, task, "fail", [lesson]);

    // Two distinct episodes, one idempotent lesson node.
    expect(first.id).not.toBe(second.id);
    const nodes = lessonNodes(client);
    expect(nodes.length).toBe(1);
    const record = parseLessonNode(nodes[0]!);
    expect(record.failCount).toBe(2);
    expect(record.episodeIds.length).toBe(2);
    expect(record.taskKey).toContain("harden token budget");
    expect(record.symbolRefs).toContain("planner.ts");

    // Precision gate passed → the lesson reaches the avoid list.
    const hints = await suggestSkillConditionHints(client, task, 3);
    const injected = hints.avoidPatterns.find(
      (p) => p.includes(lesson.slice(0, 100)) && p.includes("(2 次 episode 实证)")
    );
    expect(injected).toBe(`avoid: ${lesson}(2 次 episode 实证)`);
  });

  it("single failure → failCount=1 → node exists but is NOT injected", async () => {
    const client = new GraphifyClient();
    const task = "repair cache eviction in graphify-client.ts";
    const lesson = "do not evict cold entries before checking the graphify-client.ts index";

    await reportOutcome(client, task, "fail", [lesson]);

    const nodes = lessonNodes(client);
    expect(nodes.length).toBe(1);
    expect(parseLessonNode(nodes[0]!).failCount).toBe(1);

    const hints = await suggestSkillConditionHints(client, task, 3);
    expect(hints.avoidPatterns.some((p) => p.includes(lesson.slice(0, 100)))).toBe(false);
  });

  it("lesson that merely echoes the task text → no lesson node", async () => {
    const client = new GraphifyClient();
    const task = "update graphify-client.ts to cache query results";

    await reportOutcome(client, task, "fail", [task]);

    expect(lessonNodes(client).length).toBe(0);
    const hints = await suggestSkillConditionHints(client, task, 3);
    expect(hints.avoidPatterns).toEqual([]);
  });

  it("third failure then pass → lesson resolved and no longer injected", async () => {
    const client = new GraphifyClient();
    const task = "stabilize prompt assembly in routing.ts";
    const lesson = "stop rebuilding the prompt preamble in routing.ts on every retry";

    for (let i = 0; i < 3; i += 1) {
      await reportOutcome(client, task, "fail", [lesson]);
    }

    let hints = await suggestSkillConditionHints(client, task, 3);
    expect(
      hints.avoidPatterns.some((p) => p.includes(lesson.slice(0, 100)) && p.includes("(3 次 episode 实证)"))
    ).toBe(true);

    await reportOutcome(client, task, "pass");

    const nodes = lessonNodes(client);
    expect(nodes.length).toBe(1);
    const record = parseLessonNode(nodes[0]!);
    expect(record.resolvedAt).toBeGreaterThan(0);
    expect(record.failCount).toBe(0);

    hints = await suggestSkillConditionHints(client, task, 3);
    expect(hints.avoidPatterns.some((p) => p.includes(lesson.slice(0, 100)))).toBe(false);
  });

  it("different lessons on the same task → two independent nodes", async () => {
    const client = new GraphifyClient();
    const task = "stabilize bridge handshake in dsh-harness.ts";
    const lessonA =
      "quit early when the harness plugin rejects the dsh-harness.ts manifest";
    const lessonB =
      "always re-validate the manifest schema in dsh-harness.ts before retry";

    await reportOutcome(client, task, "fail", [lessonA]);
    await reportOutcome(client, task, "fail", [lessonB]);

    const nodes = lessonNodes(client);
    expect(nodes.length).toBe(2);
    const lessons = nodes.map((n) => parseLessonNode(n).lesson).sort();
    expect(lessons).toEqual([lessonA, lessonB].sort());
    for (const node of nodes) {
      expect(parseLessonNode(node).failCount).toBe(1);
    }
  });

  it("injection caps at 3 lessons even when 5 lessons pass the gate", async () => {
    const client = new GraphifyClient();
    const task = "tune recall thresholds in vector-index.ts";
    const lessons = [
      "do not lower the cosine floor in vector-index.ts below zero",
      "avoid reindexing vector-index.ts on every single query",
      "never trust stale embeddings cached inside vector-index.ts",
      "skip the second pass ranking in vector-index.ts when tokens match",
      "beware token drift across vector-index.ts rebuilds",
    ];

    for (const lesson of lessons) {
      await reportOutcome(client, task, "fail", [lesson]);
      await reportOutcome(client, task, "fail", [lesson]);
    }

    const nodes = lessonNodes(client);
    expect(nodes.length).toBe(5);
    for (const node of nodes) {
      expect(parseLessonNode(node).failCount).toBe(2);
    }

    const hints = await suggestSkillConditionHints(client, task, 3);
    const injected = hints.avoidPatterns.filter((p) => p.includes("次 episode 实证"));
    expect(injected.length).toBe(3);
    for (const entry of injected) {
      expect(entry).toMatch(/^avoid: .{3,}\(2 次 episode 实证\)$/);
    }
  });

  it("episodeIds bookkeeping dedupes repeated reports from the same episode and stays bounded", async () => {
    const client = new GraphifyClient();
    const task = "bound retry storms in provider-executor.ts";
    const lesson = "cap retries before they exhaust provider-executor.ts budgets";
    const rec = await reportOutcome(client, task, "fail", [lesson]);

    // Same episode reports the same failing lesson again → count, not ids.
    await updateEpisodeOutcome(client, rec.id, "fail", [lesson]);

    const nodes = lessonNodes(client);
    expect(nodes.length).toBe(1);
    const record = parseLessonNode(nodes[0]!);
    expect(record.failCount).toBe(2);
    expect(record.episodeIds).toEqual([rec.id]);
    expect(record.episodeIds.length).toBeLessThanOrEqual(10);
  });
});
