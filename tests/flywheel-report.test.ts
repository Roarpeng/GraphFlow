import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applySkillLearning } from "../src/learning/skill-flywheel";
import { recordEpisode } from "../src/learning/episodic-memory";
import { createGraphClient } from "../src/graph/client-factory";
import type { GraphNode } from "../src/core/types";
import { validateConfig } from "../src/config/loader";
import { getFlywheelReport } from "../src/surfaces/cli/runtime";

const root = mkdtempSync(join(tmpdir(), "graphflow-flywheel-report-"));
const configPath = join(root, "graphflow.config.json");
const storePath = join(root, "graph.json");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const configJson = {
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
    graphStorePath: storePath,
    maxContextTokens: 200,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly",
    exportPath: join(root, "learning.jsonl"),
  },
  embeddingPolicy: { enabled: false },
};

describe("flywheel contribution report", () => {
  it("reports skills health and episode outcomes from the graph store", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, JSON.stringify(configJson));

    const client = createGraphClient(validateConfig(JSON.parse(JSON.stringify(configJson))));

    // Seed skills: one passing task (twice → proven, positive score) and one
    // failing task (twice → anti-pattern, negative score). P0-2 taxonomy:
    // single observations stay neutral (correctable).
    await applySkillLearning(client, "refactor planner module in planner.ts and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    await applySkillLearning(client, "refactor planner module in planner.ts and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    await applySkillLearning(client, "fix broken cache layer in cache-layer.ts", {
      status: "FAILED",
      attempts: 1,
      feedback: "failed",
    });
    await applySkillLearning(client, "fix broken cache layer in cache-layer.ts", {
      status: "FAILED",
      attempts: 1,
      feedback: "failed",
    });

    // Seed episodes with distinct outcomes.
    await recordEpisode(client, {
      task: "refactor planner module",
      plan: [],
      outcome: "pass",
      keyDecisions: [],
      lessons: ["keep steps small"],
      attempts: 1,
    });
    await recordEpisode(client, {
      task: "fix broken cache layer",
      plan: [],
      outcome: "fail",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
      deviation: "misread-requirement",
    });
    await recordEpisode(client, {
      task: "delegated bridge task",
      plan: [],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 0,
    });
    await recordEpisode(client, {
      task: "over-engineered helper",
      plan: [],
      outcome: "fail",
      keyDecisions: [],
      lessons: [],
      attempts: 2,
      deviation: "scope-creep",
    });

    // Seed one goal anchor + one superseded version.
    await client.upsertNodes([
      {
        id: "goal:abc",
        type: "Decision",
        content: "goal v2: cache search",
        metadata: { kind: "goal", version: 2, status: "active", record: "{}" },
      },
      {
        id: "goal:abc:v1",
        type: "Decision",
        content: "goal v1: cache search",
        metadata: { kind: "goal", version: 1, status: "superseded", record: "{}" },
      },
    ]);

    const report = getFlywheelReport(configPath);

    expect(report.skills.total).toBeGreaterThan(0);
    expect(report.skills.positive).toBeGreaterThan(0);
    expect(report.skills.negative).toBeGreaterThan(0);
    expect(report.skills.byOutcomeKind.proven).toBeGreaterThan(0);
    expect(report.skills.byOutcomeKind["anti-pattern"]).toBeGreaterThan(0);
    expect(typeof report.autoCaptureEnabled).toBe("boolean");
    expect(report.sessionJournal).toEqual(
      expect.objectContaining({
        path: expect.stringContaining("session-journal.jsonl"),
        exists: expect.any(Boolean),
        pendingCount: expect.any(Number),
      })
    );
    expect(report.episodes.total).toBe(4);
    expect(report.episodes.pass).toBe(1);
    expect(report.episodes.fail).toBe(2);
    expect(report.episodes.pending).toBe(1);
    // pendingRatio is the pending/total share (also mirrored as pendingPercent).
    expect(report.fidelity?.pendingRatio).toBeCloseTo(report.episodes.pending / report.episodes.total, 5);
    expect(report.memoryAttribution.confidence.pendingPercent).toBe(
      Math.round((report.fidelity?.pendingRatio ?? 0) * 100)
    );
    expect(report.episodes.withLessons).toBe(1);
    expect(report.episodes.deviations.misreadRequirement).toBe(1);
    expect(report.episodes.deviations.scopeCreep).toBe(1);
    expect(report.episodes.deviations.techDrift).toBe(0);
    expect(report.goals.active).toBe(1);
    expect(report.goals.supersededVersions).toBe(1);
    expect(report.experience).toEqual(
      expect.objectContaining({
        episodeToSkillConversionRate: expect.any(Number),
        lessonsCoverageRate: expect.any(Number),
        antiPatternCount: expect.any(Number),
        provenSkillCount: expect.any(Number),
        consolidationHint: expect.any(String),
        consolidation: expect.objectContaining({
          updates: expect.any(Number),
          deletes: expect.any(Number),
          adds: expect.any(Number),
          actionable: expect.any(Number),
        }),
      })
    );
    expect(report.experience.episodeToSkillConversionRate).toBeGreaterThanOrEqual(0);
    expect(report.experience.episodeToSkillConversionRate).toBeLessThanOrEqual(1);
    // 1 of 4 episodes carries lessons
    expect(report.experience.lessonsCoverageRate).toBeCloseTo(0.25, 5);
    expect(report.experience.antiPatternCount).toBe(report.skills.byOutcomeKind["anti-pattern"]);
    expect(report.experience.provenSkillCount).toBe(report.skills.byOutcomeKind.proven);
    expect(report.experience.consolidationHint.length).toBeGreaterThan(0);
    expect(report.experience.consolidation.actionable).toBe(
      report.experience.consolidation.updates +
        report.experience.consolidation.deletes +
        report.experience.consolidation.adds
    );
  });

  it("attributes memory: recall hits, stale episodes, confidence, evidence chain, deviation breakdown", async () => {
    const attrRoot = mkdtempSync(join(tmpdir(), "graphflow-attribution-"));
    const attrConfigPath = join(attrRoot, "graphflow.config.json");
    const attrStorePath = join(attrRoot, "graph.json");
    writeFileSync(
      attrConfigPath,
      JSON.stringify({
        ...configJson,
        graphPolicy: {
          ...configJson.graphPolicy,
          workspaceRoot: attrRoot,
          graphStorePath: attrStorePath,
        },
      })
    );
    const client = createGraphClient(
      validateConfig(
        JSON.parse(
          JSON.stringify({
            ...configJson,
            graphPolicy: {
              ...configJson.graphPolicy,
              workspaceRoot: attrRoot,
              graphStorePath: attrStorePath,
            },
          })
        )
      )
    );

    // Four episodes with explicit, strictly-increasing updatedAt so the
    // recency ranking is deterministic: one pass with lessons, one fail
    // (misread-requirement), one pending, one pending flagged staleGoal
    // (goal versioning marks still-pending episodes on the node).
    const base = 1_700_000_000_000;
    const episodeNodes: GraphNode[] = [
      {
        id: "episode:pass",
        type: "Decision",
        content: "episode old pass episode with lessons",
        metadata: {
          kind: "episode",
          record: JSON.stringify({
            id: "episode:pass",
            task: "old pass episode with lessons",
            plan: [],
            outcome: "pass",
            keyDecisions: [],
            lessons: ["keep steps small", "verify early"],
            attempts: 1,
            createdAt: base,
            updatedAt: base,
            deviation: "none",
          }),
        },
      },
      {
        id: "episode:fail",
        type: "Decision",
        content: "episode fail episode misreading the requirement",
        metadata: {
          kind: "episode",
          record: JSON.stringify({
            id: "episode:fail",
            task: "fail episode misreading the requirement",
            plan: [],
            outcome: "fail",
            keyDecisions: [],
            lessons: ["verify requirements first"],
            attempts: 2,
            createdAt: base + 1000,
            updatedAt: base + 1000,
            deviation: "misread-requirement",
          }),
        },
      },
      {
        id: "episode:pending",
        type: "Decision",
        content: "episode recent pending episode awaiting report",
        metadata: {
          kind: "episode",
          record: JSON.stringify({
            id: "episode:pending",
            task: "recent pending episode awaiting report",
            plan: [],
            outcome: "pending",
            keyDecisions: [],
            lessons: [],
            attempts: 0,
            createdAt: base + 2000,
            updatedAt: base + 2000,
          }),
        },
      },
      {
        id: "episode:stale",
        type: "Decision",
        content: "episode stale pending episode superseded by goal v2",
        metadata: {
          kind: "episode",
          staleGoal: "goal:abc",
          record: JSON.stringify({
            id: "episode:stale",
            task: "stale pending episode superseded by goal v2 which changed the success criteria and the core problem",
            plan: [],
            outcome: "pending",
            keyDecisions: [],
            lessons: [],
            attempts: 1,
            createdAt: base + 3000,
            updatedAt: base + 3000,
          }),
        },
      },
    ];
    await client.upsertNodes(episodeNodes);

    const report = getFlywheelReport(attrConfigPath);
    const m = report.memoryAttribution;

    // Section shape: every attribution field present.
    expect(m).toHaveProperty("memoryHits");
    expect(m).toHaveProperty("staleEpisodes");
    expect(m).toHaveProperty("confidence");
    expect(m).toHaveProperty("topContributingMemories");
    expect(m).toHaveProperty("deviationBreakdown");

    // memoryHits: no per-run recall telemetry is persisted in episode
    // records, so the fallback is episodes carrying lessons.
    expect(m.memoryHits).toBe(2);

    // staleEpisodes: only the goal-versioned pending episode counts.
    expect(m.staleEpisodes).toBe(1);

    // Confidence: pass/fail/pending distribution percentages.
    // pendingRatio (pending / total) is the obvious pending share: 2/4 = 50%.
    expect(m.confidence).toEqual({ passPercent: 25, failPercent: 25, pendingPercent: 50 });
    expect(report.fidelity?.pendingRatio).toBeCloseTo(0.5, 5);
    expect(m.confidence.pendingPercent).toBe(Math.round((report.fidelity?.pendingRatio ?? 0) * 100));

    // Evidence chain: top 3 most-recent episodes, newest first, with
    // truncated task, outcome, and lesson count.
    expect(m.topContributingMemories).toHaveLength(3);
    expect(m.topContributingMemories.map((e) => e.id)).toEqual([
      "episode:stale",
      "episode:pending",
      "episode:fail",
    ]);
    expect(m.topContributingMemories.map((e) => e.lessonsCount)).toEqual([0, 0, 1]);
    expect(m.topContributingMemories[0]!.outcome).toBe("pending");
    expect(m.topContributingMemories[0]!.id).toBe("episode:stale");
    // Long tasks are truncated to 60 chars in the evidence chain.
    expect(m.topContributingMemories[0]!.task.length).toBe(60);
    expect(m.topContributingMemories[0]!.task.endsWith("...")).toBe(true);

    // Deviation breakdown aggregated per category across episode records.
    expect(m.deviationBreakdown).toEqual({
      none: 1,
      misreadRequirement: 1,
      scopeCreep: 0,
      techDrift: 0,
    });

    rmSync(attrRoot, { recursive: true, force: true });
  });

  it("returns an empty report for a missing store (read-only, no indexing)", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "graphflow-flywheel-empty-"));
    const emptyConfigPath = join(emptyRoot, "graphflow.config.json");
    writeFileSync(
      emptyConfigPath,
      JSON.stringify({
        ...configJson,
        graphPolicy: {
          ...configJson.graphPolicy,
          workspaceRoot: emptyRoot,
          graphStorePath: join(emptyRoot, "missing.json"),
        },
      })
    );

    const report = getFlywheelReport(emptyConfigPath);
    expect(report.skills.total).toBe(0);
    expect(report.episodes.total).toBe(0);
    expect(report.skills.byOutcomeKind).toEqual({
      proven: 0,
      correctable: 0,
      "anti-pattern": 0,
      noise: 0,
    });
    expect(report.experience).toEqual({
      episodeToSkillConversionRate: 0,
      lessonsCoverageRate: 0,
      antiPatternCount: 0,
      provenSkillCount: 0,
      consolidationHint: "Experience flywheel looks healthy.",
      consolidation: { updates: 0, deletes: 0, adds: 0, actionable: 0 },
    });
    expect(typeof report.autoCaptureEnabled).toBe("boolean");
    expect(report.sessionJournal.exists).toBe(false);
    expect(report.sessionJournal.pendingCount).toBe(0);
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("reports auto-capture health, skill outcomeKind counts, and session journal pending", async () => {
    const healthRoot = mkdtempSync(join(tmpdir(), "graphflow-flywheel-health-"));
    const healthConfigPath = join(healthRoot, "graphflow.config.json");
    const healthStorePath = join(healthRoot, "graph.json");
    writeFileSync(
      healthConfigPath,
      JSON.stringify({
        ...configJson,
        graphPolicy: {
          ...configJson.graphPolicy,
          workspaceRoot: healthRoot,
          graphStorePath: healthStorePath,
        },
      })
    );
    const client = createGraphClient(
      validateConfig(
        JSON.parse(
          JSON.stringify({
            ...configJson,
            graphPolicy: {
              ...configJson.graphPolicy,
              workspaceRoot: healthRoot,
              graphStorePath: healthStorePath,
            },
          })
        )
      )
    );

    // Seed classified skills: proven (2× pass) and anti-pattern (2× fail).
    await applySkillLearning(client, "refactor health planner in planner.ts", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    await applySkillLearning(client, "refactor health planner in planner.ts", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    await applySkillLearning(client, "fix health cache in cache-layer.ts", {
      status: "FAILED",
      attempts: 1,
      feedback: "failed",
    });
    await applySkillLearning(client, "fix health cache in cache-layer.ts", {
      status: "FAILED",
      attempts: 1,
      feedback: "failed",
    });

    await recordEpisode(client, {
      task: "health pending episode",
      plan: [],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 0,
    });

    // Write a session-journal pending entry under the workspace root.
    mkdirSync(join(healthRoot, ".graphflow"), { recursive: true });
    writeFileSync(
      join(healthRoot, ".graphflow", "session-journal.jsonl"),
      `${JSON.stringify({
        version: 1,
        kind: "pending-episode",
        episodeId: "episode:journal-1",
        task: "journaled task",
        taskKey: "abc",
        createdAt: Date.now(),
      })}\n${JSON.stringify({
        version: 1,
        kind: "pending-episode",
        episodeId: "episode:journal-2",
        task: "another journaled task",
        taskKey: "def",
        createdAt: Date.now(),
      })}\n`
    );

    const prev = process.env.GRAPHFLOW_AUTO_CAPTURE;
    delete process.env.GRAPHFLOW_AUTO_CAPTURE;
    try {
      const report = getFlywheelReport(healthConfigPath);

      expect(report.autoCaptureEnabled).toBe(true);
      expect(report.sessionJournal.exists).toBe(true);
      expect(report.sessionJournal.path).toContain("session-journal.jsonl");
      expect(report.sessionJournal.pendingCount).toBe(2);
      expect(report.episodes.total).toBe(1);
      expect(report.episodes.pending).toBe(1);
      expect(report.skills.byOutcomeKind.proven).toBeGreaterThan(0);
      expect(report.skills.byOutcomeKind["anti-pattern"]).toBeGreaterThan(0);
      expect(report.skills.byOutcomeKind).toEqual(
        expect.objectContaining({
          proven: expect.any(Number),
          correctable: expect.any(Number),
          "anti-pattern": expect.any(Number),
          noise: expect.any(Number),
        })
      );

      process.env.GRAPHFLOW_AUTO_CAPTURE = "0";
      expect(getFlywheelReport(healthConfigPath).autoCaptureEnabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GRAPHFLOW_AUTO_CAPTURE;
      else process.env.GRAPHFLOW_AUTO_CAPTURE = prev;
      rmSync(healthRoot, { recursive: true, force: true });
    }
  });

  it("exposes consolidation action counts and surfaces them via diagnose", async () => {
    const consolRoot = mkdtempSync(join(tmpdir(), "graphflow-flywheel-consol-"));
    const consolConfigPath = join(consolRoot, "graphflow.config.json");
    const consolStorePath = join(consolRoot, "graph.json");
    writeFileSync(
      consolConfigPath,
      JSON.stringify({
        ...configJson,
        graphPolicy: {
          ...configJson.graphPolicy,
          workspaceRoot: consolRoot,
          graphStorePath: consolStorePath,
        },
      })
    );
    const client = createGraphClient(
      validateConfig(
        JSON.parse(
          JSON.stringify({
            ...configJson,
            graphPolicy: {
              ...configJson.graphPolicy,
              workspaceRoot: consolRoot,
              graphStorePath: consolStorePath,
            },
          })
        )
      )
    );

    const survivor = {
      id: "skill:cache-layer",
      name: "Cache Layer",
      score: 4,
      uses: 3,
      lastOutcome: "pass" as const,
      updatedAt: 1,
      outcomeKind: "proven" as const,
      guidance: "keep keys",
    };
    const duplicate = {
      id: "skill:cache_layer",
      name: "cache_layer",
      score: 1,
      uses: 1,
      lastOutcome: "pass" as const,
      updatedAt: 1,
      outcomeKind: "correctable" as const,
      guidance: "invalidate",
    };
    await client.upsertNodes([
      { id: survivor.id, type: "Skill", content: JSON.stringify(survivor) },
      { id: duplicate.id, type: "Skill", content: JSON.stringify(duplicate) },
    ]);

    const report = getFlywheelReport(consolConfigPath);
    expect(report.experience.consolidation.updates).toBeGreaterThanOrEqual(1);
    expect(report.experience.consolidation.deletes).toBeGreaterThanOrEqual(1);
    expect(report.experience.consolidation.actionable).toBeGreaterThan(0);
    expect(report.experience.consolidationHint).toMatch(/Consolidation suggested|skill consolidate/i);

    const { diagnoseRoutingResult } = await import("../src/surfaces/cli/runtime");
    const diagnosis = diagnoseRoutingResult(consolConfigPath);
    expect(diagnosis.flywheel?.experience?.consolidation?.actionable).toBe(
      report.experience.consolidation.actionable
    );
    expect(diagnosis.flywheel?.experience?.consolidationHint).toBe(report.experience.consolidationHint);

    rmSync(consolRoot, { recursive: true, force: true });
  });
});
