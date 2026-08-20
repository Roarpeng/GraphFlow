import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  loadEpisode,
  recordEpisode,
  updateEpisodeOutcome,
} from "../src/learning/episodic-memory";
import { parseSkillState } from "../src/learning/skill-store";
import {
  distillWorkflowFromEpisode,
  workflowSkillId,
} from "../src/learning/workflow-skill";

function makeClient(): GraphifyClient {
  return new GraphifyClient();
}

describe("AWM workflow skill distillation", () => {
  it("distills a passing multi-step episode into one workflow skill with numbered guidance", async () => {
    const client = makeClient();
    const episode = await recordEpisode(client, {
      task: "refactor planner.ts and add tests",
      plan: [
        { id: "task-1", description: "split planner.ts into modules" },
        { id: "task-2", description: "add tests for planner.ts" },
      ],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });

    const skillId = await distillWorkflowFromEpisode(client, episode);
    expect(skillId).toBe(workflowSkillId(episode.plan));
    expect(skillId).toMatch(/^skill:workflow:/);

    const snapshot = client.snapshot();
    const skillNodes = snapshot.nodes.filter((node) => node.type === "Skill");
    expect(skillNodes).toHaveLength(1);

    const state = parseSkillState(skillNodes[0]!.content);
    expect(state).toBeDefined();
    expect(state?.id).toBe(skillId);
    expect(state?.name).toBe("workflow: refactor planner.ts and add tests");
    expect(state?.seeded).toBeUndefined();
    expect(state?.outcomeKind).toBe("correctable");
    expect(state?.hasSymbolEvidence).toBe(true);
    expect(state?.provenance).toEqual({ source: "local", episodeId: episode.id });
    expect(state?.guidance).toContain("1. split planner.ts into modules");
    expect(state?.guidance).toContain("2. add tests for planner.ts");

    const edge = snapshot.edges.find(
      (item) => item.from === skillId && item.relation === "derived_from"
    );
    expect(edge?.to).toBe(episode.id);
  });

  it("does not crash and skips distillation when the plan is empty", async () => {
    const client = makeClient();
    const episode = await recordEpisode(client, {
      task: "noop",
      plan: [],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });

    await expect(distillWorkflowFromEpisode(client, episode)).resolves.toBeUndefined();
    expect(client.snapshot().nodes.filter((node) => node.type === "Skill")).toHaveLength(0);
  });

  it("skips distillation when outcome is not pass or the plan has fewer than 2 steps", async () => {
    const client = makeClient();
    const failed = await recordEpisode(client, {
      task: "refactor planner.ts",
      plan: [
        { id: "a", description: "edit planner.ts" },
        { id: "b", description: "retest planner.ts" },
      ],
      outcome: "fail",
      keyDecisions: [],
      lessons: [],
      attempts: 2,
    });
    const single = await recordEpisode(client, {
      task: "refactor planner.ts",
      plan: [{ id: "a", description: "edit planner.ts" }],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });

    await expect(distillWorkflowFromEpisode(client, failed)).resolves.toBeUndefined();
    await expect(distillWorkflowFromEpisode(client, single)).resolves.toBeUndefined();
    expect(client.snapshot().nodes.filter((node) => node.type === "Skill")).toHaveLength(0);
  });

  it("distills from updateEpisodeOutcome when a pending episode becomes pass", async () => {
    const client = makeClient();
    const pending = await recordEpisode(client, {
      task: "wire auth.ts login flow",
      plan: [
        { id: "s1", description: "extract token helper in auth.ts" },
        { id: "s2", description: "add login tests" },
      ],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 0,
    });

    const loaded = await loadEpisode(client, pending.id);
    expect(loaded?.plan).toHaveLength(2);

    const updated = await updateEpisodeOutcome(client, pending.id, "pass", ["keep helpers small"]);
    expect(updated?.outcome).toBe("pass");

    const skillId = workflowSkillId(pending.plan);
    const node = client.snapshot().nodes.find((item) => item.id === skillId);
    expect(node?.type).toBe("Skill");
    const state = parseSkillState(node!.content);
    expect(state?.guidance).toMatch(/^1\. extract token helper in auth\.ts/m);
    expect(state?.outcomeKind).toBe("correctable");
  });
});
