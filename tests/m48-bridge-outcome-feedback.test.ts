import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { orchestrate } from "../src/core/orchestrator";
import { recordEpisode, updateEpisodeOutcome, findSimilarEpisodes } from "../src/learning/episodic-memory";
import { applySkillLearning, suggestSkillHints } from "../src/learning/skill-flywheel";

describe("M48 bridge mode outcome feedback loop", () => {
  // ── Task 1: Bridge mode returns DELEGATED, not HUMAN_REVIEW_REQUIRED ──
  it("should return DELEGATED status in bridge mode (not HUMAN_REVIEW_REQUIRED)", async () => {
    const client = new GraphifyClient();
    const run = await orchestrate(
      { task: "refactor the context compression pipeline" },
      {
        graphClient: client,
        enableEpisodicMemory: true,
        executionMode: "bridge",
      }
    );

    expect(run.status).toBe("DELEGATED");
    expect(run.feedback).toContain("[DELEGATED]");
    expect(run.executionDescriptor).toBeDefined();
    expect(run.episodeId).toBeDefined();
  });

  // ── Task 2: Skill scores are NOT penalized in bridge mode ──────────
  it("should not penalize skill scores during bridge delegation", async () => {
    const client = new GraphifyClient();
    const run = await orchestrate(
      { task: "update readme and add tests" },
      {
        graphClient: client,
        enableEpisodicMemory: true,
        enableSkillFlywheel: true,
        executionMode: "bridge",
      }
    );

    expect(run.status).toBe("DELEGATED");

    // No skill nodes should have been created with negative scores
    // because maybeSyncSkillGraph skips DELEGATED status.
    const snapshot = client.snapshot();
    const skillNodes = snapshot.nodes.filter((n) => n.type === "Skill");
    expect(skillNodes.length).toBe(0);
  });

  // ── Task 3: Episode is recorded as "pending" in bridge mode ────────
  it("should record episode with pending outcome in bridge mode", async () => {
    const client = new GraphifyClient();
    const run = await orchestrate(
      { task: "add benchmarks for compression" },
      {
        graphClient: client,
        enableEpisodicMemory: true,
        executionMode: "bridge",
      }
    );

    expect(run.episodeId).toBeDefined();
    const episodes = await findSimilarEpisodes(client, "add benchmarks for compression", 5);
    const matching = episodes.find((e) => e.id === run.episodeId);
    expect(matching).toBeDefined();
    expect(matching?.outcome).toBe("pending");
  });

  // ── Task 4: updateEpisodeOutcome closes the loop ──────────────────
  it("should update episode outcome from pending to pass via updateEpisodeOutcome", async () => {
    const client = new GraphifyClient();

    // Record an episode as pending (simulating bridge mode)
    const recorded = await recordEpisode(client, {
      task: "refactor auth module",
      plan: [{ id: "task-1", description: "refactor auth" }],
      outcome: "pending",
      keyDecisions: ["split into smaller functions"],
      lessons: [],
      attempts: 0,
    });

    // External agent reports success
    const updated = await updateEpisodeOutcome(client, recorded.id, "pass", [
      "extracted token validation",
    ]);

    expect(updated).toBeDefined();
    expect(updated?.outcome).toBe("pass");
    expect(updated?.lessons).toContain("extracted token validation");

    // Verify the update persisted
    const episodes = await findSimilarEpisodes(client, "refactor auth module", 5);
    const matching = episodes.find((e) => e.id === recorded.id);
    expect(matching?.outcome).toBe("pass");
  });

  // ── Task 5: Full closed loop — bridge → report → skill learns ──────
  it("should apply positive skill learning after reportOutcome with success", async () => {
    const client = new GraphifyClient();

    // Step 1: Bridge mode — task delegated, skill NOT penalized
    const run = await orchestrate(
      { task: "update readme and add tests" },
      {
        graphClient: client,
        enableEpisodicMemory: true,
        enableSkillFlywheel: true,
        executionMode: "bridge",
      }
    );

    expect(run.status).toBe("DELEGATED");
    expect(run.episodeId).toBeDefined();

    // No skills learned yet (bridge skipped skill sync)
    let snapshot = client.snapshot();
    expect(snapshot.nodes.filter((n) => n.type === "Skill").length).toBe(0);

    // Step 2: External agent reports success — closes the loop
    const updated = await updateEpisodeOutcome(
      client,
      run.episodeId!,
      "pass",
      ["keep readme sections concise"]
    );
    expect(updated?.outcome).toBe("pass");

    // Step 3: Apply skill learning with the reported success
    await applySkillLearning(client, updated!.task, {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });

    // Now skills should exist with positive scores
    snapshot = client.snapshot();
    const skillNodes = snapshot.nodes.filter((n) => n.type === "Skill");
    expect(skillNodes.length).toBeGreaterThan(0);

    // Skill hints should now be available for similar tasks
    const hints = await suggestSkillHints(client, "update readme", 3);
    expect(hints.length).toBeGreaterThan(0);
  });

  // ── Task 6: updateEpisodeOutcome returns undefined for unknown id ──
  it("should return undefined when episode id does not exist", async () => {
    const client = new GraphifyClient();
    const result = await updateEpisodeOutcome(client, "episode:nonexistent", "pass");
    expect(result).toBeUndefined();
  });
});
