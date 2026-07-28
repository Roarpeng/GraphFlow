import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applySkillLearning } from "../src/learning/skill-flywheel";
import { recordEpisode } from "../src/learning/episodic-memory";
import { createGraphClient } from "../src/graph/client-factory";
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

    // Seed skills: one passing task, one failing task.
    await applySkillLearning(client, "refactor planner module and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    await applySkillLearning(client, "fix broken cache layer", {
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
    });
    await recordEpisode(client, {
      task: "delegated bridge task",
      plan: [],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 0,
    });

    const report = getFlywheelReport(configPath);

    expect(report.skills.total).toBeGreaterThan(0);
    expect(report.skills.positive).toBeGreaterThan(0);
    expect(report.skills.negative).toBeGreaterThan(0);
    expect(report.episodes.total).toBe(3);
    expect(report.episodes.pass).toBe(1);
    expect(report.episodes.fail).toBe(1);
    expect(report.episodes.pending).toBe(1);
    expect(report.episodes.withLessons).toBe(1);
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
    rmSync(emptyRoot, { recursive: true, force: true });
  });
});
