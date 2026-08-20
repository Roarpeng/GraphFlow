import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { orchestrate } from "../src/core/orchestrator";
import { recordEpisode, updateEpisodeOutcome, findSimilarEpisodes } from "../src/learning/episodic-memory";
import { applySkillLearning, suggestSkillHints } from "../src/learning/skill-flywheel";
import { reportOutcome, runTaskResult, getSkillInsights } from "../src/surfaces/cli/runtime";
import { shouldApplySkillLearningFromOutcome } from "../src/surfaces/cli/runtime/routing";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";

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
        configPath: createNoLlmConfigPath(),
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
      { task: "refactor planner and add tests" },
      {
        graphClient: client,
        enableEpisodicMemory: true,
        enableSkillFlywheel: true,
        executionMode: "bridge",
        configPath: createNoLlmConfigPath(),
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
        configPath: createNoLlmConfigPath(),
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
      { task: "refactor planner.ts and add tests" },
      {
        graphClient: client,
        enableEpisodicMemory: true,
        enableSkillFlywheel: true,
        executionMode: "bridge",
        configPath: createNoLlmConfigPath(),
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
      ["keep planner steps small"]
    );
    expect(updated?.outcome).toBe("pass");

    // Step 3: Apply skill learning with the reported success
    await applySkillLearning(
      client,
      updated!.task,
      {
        status: "COMPLETED",
        attempts: 1,
        feedback: "done",
      },
      updated!.lessons
    );

    // Now skills should exist with positive scores
    snapshot = client.snapshot();
    const skillNodes = snapshot.nodes.filter((n) => n.type === "Skill");
    expect(skillNodes.length).toBeGreaterThan(0);

    // Skill hints should now be available for similar tasks
    const hints = await suggestSkillHints(client, "refactor planner.ts and add tests", 3);
    expect(hints.length).toBeGreaterThan(0);
  });

  it("shouldApplySkillLearningFromOutcome skips pass without quality lessons", () => {
    expect(shouldApplySkillLearningFromOutcome(true, "refactor planner.ts and add tests", [])).toBe(
      false
    );
    expect(
      shouldApplySkillLearningFromOutcome(true, "refactor planner.ts and add tests", [
        "keep planner.ts small",
      ])
    ).toBe(true);
    expect(shouldApplySkillLearningFromOutcome(false, "refactor planner.ts and add tests", [])).toBe(
      false
    );
  });

  it("reportOutcome pass without lessons records pass but does not apply skill learning", async () => {
    const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
    process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = "1000";
    const root = mkdtempSync(join(tmpdir(), "graphflow-report-outcome-nolearn-"));
    const storePath = join(root, "graph-store.json");
    const configPath = createNoLlmConfigPath({
      skillPolicy: { enableSkillFlywheel: true, maxSkillHints: 4 },
      graphPolicy: {
        transport: "file",
        graphStorePath: storePath,
        autoIndexOnRun: false,
        autoIndexOnPreview: false,
        autoIndexOnSave: false,
        workspaceRoot: root,
      },
    });
    try {
      const runResult = await runTaskResult("refactor planner.ts and add tests", configPath);
      expect(runResult.episodeId).toBeDefined();
      const reported = await reportOutcome(runResult.episodeId!, true, [], configPath);
      expect(reported.ok).toBe(true);
      expect(reported.outcome).toBe("pass");
      expect(reported.skillsUpdated ?? 0).toBe(0);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Task 5b: reportOutcome path seeds skills from lessons ──────────
  it("reportOutcome marks episode pass and writes skills from lessons", async () => {
    const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
    process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = "1000";

    const root = mkdtempSync(join(tmpdir(), "graphflow-report-outcome-"));
    const configPath = join(root, "graphflow.config.json");
    const storePath = join(root, "graph-store.json");

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            providers: {},
            tiers: {
              smart: { provider: "openai", model: "gpt-5.3-codex" },
              economy: { provider: "openai", model: "gpt-4.1-mini" },
            },
            budgetPolicy: { runTokenCap: 2000 },
            graphPolicy: {
              enableAutoBuild: true,
              enableNearLosslessMode: true,
              autoIndexOnPreview: false,
              autoIndexOnRun: true,
              workspaceRoot: root,
              includeExtensions: [".ts"],
              transport: "file",
              graphStorePath: storePath,
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              exportPath: join(root, "learning.jsonl"),
            },
            skillPolicy: {
              enableSkillFlywheel: true,
              maxSkillHints: 4,
            },
            routingPolicy: {
              enableDynamicRouting: false,
              requireApiKeyForHealthy: true,
            },
          },
          null,
          2
        ),
        "utf8"
      );

      // Skill-poor task alone yields no atoms; lessons must seed skills.
      const runResult = await runTaskResult("go", configPath);
      expect(runResult.episodeId).toBeDefined();

      const reported = await reportOutcome(
        runResult.episodeId!,
        true,
        ["prefer concise regression checks in regression-checks.ts", "keep sections focused on goal-anchor.ts"],
        configPath
      );

      expect(reported.ok).toBe(true);
      expect(reported.outcome).toBe("pass");
      expect(reported.skillsUpdated).toBeGreaterThan(0);

      const insights = await getSkillInsights(configPath, 10);
      expect(insights.skills.length).toBeGreaterThan(0);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  // ── Task 5c: lessons alone can seed skill atoms ────────────────────
  it("applySkillLearning uses lessons when task text is skill-poor", async () => {
    const client = new GraphifyClient();
    const withoutLessons = await applySkillLearning(
      client,
      "go",
      { status: "COMPLETED", attempts: 1, feedback: "done" }
    );
    expect(withoutLessons).toBe(0);

    const withLessons = await applySkillLearning(
      client,
      "go",
      { status: "COMPLETED", attempts: 1, feedback: "done" },
      ["prefer concise regression checks in regression-checks.ts"]
    );

    expect(withLessons).toBeGreaterThan(0);
    const snapshot = client.snapshot();
    expect(snapshot.nodes.some((node) => node.type === "Skill")).toBe(true);
  });

  // ── Task 6: updateEpisodeOutcome returns undefined for unknown id ──
  it("should return undefined when episode id does not exist", async () => {
    const client = new GraphifyClient();
    const result = await updateEpisodeOutcome(client, "episode:nonexistent", "pass");
    expect(result).toBeUndefined();
  });
});
