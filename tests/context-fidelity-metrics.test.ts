import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getFlywheelReport } from "../src/surfaces/cli/runtime";
import {
  getContextFidelityStats,
  listContextFidelityRecords,
  recordContextFidelity,
  resetContextFidelityStats,
} from "../src/graph/token-savings";
import { resolveConfig } from "../src/config/resolve";

const root = mkdtempSync(join(tmpdir(), "graphflow-context-fidelity-"));
const configPath = join(root, "graphflow.config.json");

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
    enableAutoBuild: false,
    workspaceRoot: root,
    transport: "file" as const,
    graphStorePath: join(root, "graph.json"),
    maxContextTokens: 200,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly" as const,
    exportPath: join(root, "learning.jsonl"),
  },
  embeddingPolicy: { enabled: false },
};

describe("context fidelity metrics", () => {
  it("measures recall@k, missing anchors, and supplied-body coverage", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, JSON.stringify(configJson));
    const config = resolveConfig(configPath);
    resetContextFidelityStats(config);
    const missingOnly = recordContextFidelity(config, {
      query: "missing anchors",
      expectedAnchorIds: ["anchor:a", "anchor:b", "anchor:a"],
      returnedAnchorIds: ["anchor:b", "anchor:c"],
      source: "evaluation",
    });

    expect(missingOnly.anchorRecallAtK).toBe(1 / 2);
    expect(missingOnly.missingAnchorIds).toEqual(["anchor:a"]);
    expect(missingOnly.bodyCoverage).toBeUndefined();

    const covered = recordContextFidelity(config, {
      query: "partial body",
      expectedAnchorIds: ["anchor:x", "anchor:y"],
      returnedAnchorIds: ["anchor:x"],
      expectedBodies: {
        "anchor:x": "abcde",
        "anchor:y": "export const lost = true;",
      },
      packagedBodies: {
        "anchor:x": "abZde",
        "anchor:extra": "unrelated body",
      },
      source: "preview_context",
    });

    expect(covered.anchorRecallAtK).toBe(1 / 2);
    expect(covered.missingAnchorIds).toEqual(["anchor:y"]);
    // Four of five source characters retain their order in the package.
    expect(covered.bodyCoverage).toBeCloseTo(4 / 5, 12);

    const stats = getContextFidelityStats(config);
    expect(stats.sampleCount).toBe(2);
    expect(stats.averageAnchorRecallPercent).toBe(50);
    expect(stats.averageBodyCoveragePercent).toBe(80);
    // Anchor IDs are deduplicated before recall and totals are calculated.
    expect(stats.totalExpectedAnchors).toBe(4);
    expect(stats.totalReturnedAnchors).toBe(3);
    expect(stats.totalMissingAnchors).toBe(2);
    expect(stats.bodyCoverageSampleCount).toBe(1);
    expect(listContextFidelityRecords(config)).toHaveLength(2);
  });

  it("aggregates measured metrics in FlywheelReport and resets independently", () => {
    const report = getFlywheelReport(configPath);
    expect(report.fidelity?.sampleCount).toBe(2);
    expect(report.fidelity?.averageAnchorRecallPercent).toBe(50);
    expect(report.fidelity?.averageBodyCoveragePercent).toBe(80);
    expect(report.fidelity?.estimatedSavingsPercent).toBe(0);
    expect(report.fidelity?.pendingRatio).toBe(0);
    expect(report.fidelity?.note).toContain("savings is not body fidelity");

    const config = resolveConfig(configPath);
    expect(resetContextFidelityStats(config)).toMatchObject({ reset: true });
    expect(getContextFidelityStats(config).sampleCount).toBe(0);
    expect(listContextFidelityRecords(config)).toEqual([]);
    expect(getFlywheelReport(configPath).fidelity?.sampleCount).toBe(0);
    expect(getFlywheelReport(configPath).fidelity?.averageBodyCoveragePercent).toBe(0);
  });
});
