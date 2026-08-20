import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getFlywheelReport, getTokenSavingsStats } from "../src/surfaces/cli/runtime";
import {
  explainSavings,
  recordSavings,
  SAVINGS_NOT_FIDELITY_NOTE,
} from "../src/graph/token-savings";
import { resolveConfig } from "../src/config/resolve";

const root = mkdtempSync(join(tmpdir(), "graphflow-fidelity-"));
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
    transport: "file" as const,
    graphStorePath: storePath,
    maxContextTokens: 200,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly" as const,
    exportPath: join(root, "learning.jsonl"),
  },
  embeddingPolicy: { enabled: false },
};

describe("context fidelity vs token savings", () => {
  it("explainSavings states savings is not body fidelity", () => {
    const text = explainSavings();
    expect(text).toContain("Hit@k");
    expect(text).toContain(SAVINGS_NOT_FIDELITY_NOTE);
    expect(text.toLowerCase()).not.toContain("100% lossless");
    expect(text.toLowerCase()).not.toMatch(/lossless fidelity/);
  });

  it("FlywheelReport.fidelity splits savingsPercent from pending/unknown ratios", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, JSON.stringify(configJson));
    writeFileSync(
      storePath,
      JSON.stringify({
        nodes: [
          {
            id: "episode:pending",
            type: "Decision",
            content: "pending task",
            metadata: {
              kind: "episode",
              record: JSON.stringify({
                id: "episode:pending",
                task: "pending task",
                outcome: "pending",
                lessons: [],
                updatedAt: 1,
              }),
            },
          },
          {
            id: "episode:pass",
            type: "Decision",
            content: "passed task",
            metadata: {
              kind: "episode",
              record: JSON.stringify({
                id: "episode:pass",
                task: "passed task",
                outcome: "pass",
                lessons: [],
                updatedAt: 2,
              }),
            },
          },
        ],
        edges: [],
      })
    );

    const config = resolveConfig(configPath);
    recordSavings(config, {
      timestamp: new Date().toISOString(),
      query: "fidelity split",
      rawTokens: 1000,
      compressedTokens: 100,
      savingsPercent: 90,
      source: "preview_context",
    });

    const report = getFlywheelReport(configPath);
    expect(report.fidelity).toBeDefined();
    expect(report.fidelity!.pendingRatio).toBe(0.5);
    expect(report.fidelity!.unknownOutcomeRatio).toBe(report.fidelity!.pendingRatio);
    expect(report.fidelity!.pendingRatio).toBe(report.memoryAttribution.confidence.pendingPercent / 100);
    expect(report.fidelity!.estimatedSavingsPercent).toBe(90);
    expect(report.fidelity!.note).toBe(SAVINGS_NOT_FIDELITY_NOTE);

    const stats = getTokenSavingsStats(configPath);
    expect(stats.explanation).toContain("not retrieval Hit@k");
    expect(stats.recentRecords[0]?.kind).toBe("tokens-not-fidelity");
  });
});
