import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  forgetEpisode,
  recordEpisode,
  updateEpisodeOutcome,
} from "../src/learning/episodic-memory";
import { parseSkillState, serializeAtomic } from "../src/learning/skill-store";
import {
  distillWorkflowFromEpisode,
  quarantineSkillsFromEpisode,
  workflowSkillId,
} from "../src/learning/workflow-skill";
import type { SkillState } from "../src/learning/skill-types";

function makeClient(): GraphifyClient {
  return new GraphifyClient();
}

describe("SkillJack descendant skill revocation", () => {
  it("forgetEpisode hides the distilled workflow skill without deleting it", async () => {
    const client = makeClient();
    const episode = await recordEpisode(client, {
      task: "refactor planner.ts and add tests",
      plan: [
        { id: "task-1", description: "split planner.ts" },
        { id: "task-2", description: "cover planner.ts with tests" },
      ],
      outcome: "pass",
      keyDecisions: [],
      lessons: ["keep public api"],
      attempts: 1,
    });

    const skillId = await distillWorkflowFromEpisode(client, episode);
    expect(skillId).toBeDefined();

    const result = await forgetEpisode(client, episode.id);
    expect(result.found).toBe(true);
    expect(result.pruned).toBe(true);
    expect(result.ids).toContain(skillId);
    expect(result.hidden).toBe(1);

    const node = client.snapshot().nodes.find((item) => item.id === skillId);
    expect(node).toBeDefined();
    const state = parseSkillState(node!.content);
    expect(state?.hidden).toBe(true);
    expect(state?.outcomeKind).toBe("correctable");
    expect(state?.provenance?.episodeId).toBe(episode.id);

    const episodeNode = client.snapshot().nodes.find((item) => item.id === episode.id);
    expect(episodeNode).toBeDefined();
    expect(episodeNode?.metadata?.pruned).toBe(true);
  });

  it("does not hide skills distilled from a different episode", async () => {
    const client = makeClient();
    const keep = await recordEpisode(client, {
      task: "fix auth.ts validation",
      plan: [
        { id: "a", description: "tighten auth.ts checks" },
        { id: "b", description: "add auth.ts tests" },
      ],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });
    const drop = await recordEpisode(client, {
      task: "rewrite planner.ts pipeline",
      plan: [
        { id: "p1", description: "split planner.ts" },
        { id: "p2", description: "retest planner.ts" },
      ],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });

    const keepId = await distillWorkflowFromEpisode(client, keep);
    const dropId = await distillWorkflowFromEpisode(client, drop);
    expect(keepId).toBeDefined();
    expect(dropId).toBeDefined();

    const result = await forgetEpisode(client, drop.id);
    expect(result.ids).toEqual([dropId]);

    const snapshot = client.snapshot();
    const keepState = parseSkillState(snapshot.nodes.find((n) => n.id === keepId)!.content);
    const dropState = parseSkillState(snapshot.nodes.find((n) => n.id === dropId)!.content);
    expect(keepState?.hidden).toBeUndefined();
    expect(dropState?.hidden).toBe(true);
  });

  it("quarantine keeps outcomeKind and is a no-op when the plan was empty", async () => {
    const client = makeClient();
    const empty = await recordEpisode(client, {
      task: "empty plan",
      plan: [],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });

    await expect(distillWorkflowFromEpisode(client, empty)).resolves.toBeUndefined();
    await expect(forgetEpisode(client, empty.id)).resolves.toMatchObject({
      found: true,
      hidden: 0,
      ids: [],
      pruned: true,
    });

    const unrelated: SkillState = {
      id: "skill:unrelated",
      name: "unrelated",
      score: 1,
      uses: 1,
      lastOutcome: "pass",
      updatedAt: Date.now(),
      outcomeKind: "proven",
      provenance: { source: "local", episodeId: "episode:other" },
    };
    await client.upsertNodes([
      { id: unrelated.id, type: "Skill", content: serializeAtomic(unrelated) },
    ]);

    const again = await quarantineSkillsFromEpisode(client, empty.id);
    expect(again.hidden).toBe(0);
    expect(parseSkillState(client.snapshot().nodes.find((n) => n.id === unrelated.id)!.content)?.hidden).toBeUndefined();
  });

  it("hides a workflow skill created via updateEpisodeOutcome", async () => {
    const client = makeClient();
    const pending = await recordEpisode(client, {
      task: "implement cache.ts layer",
      plan: [
        { id: "c1", description: "add cache.ts wrapper" },
        { id: "c2", description: "test cache.ts eviction" },
      ],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 0,
    });

    await updateEpisodeOutcome(client, pending.id, "pass");
    const skillId = workflowSkillId(pending.plan);
    expect(client.snapshot().nodes.some((n) => n.id === skillId)).toBe(true);

    const result = await forgetEpisode(client, pending.id);
    expect(result.hidden).toBe(1);
    expect(parseSkillState(client.snapshot().nodes.find((n) => n.id === skillId)!.content)?.hidden).toBe(
      true
    );
  });
});
