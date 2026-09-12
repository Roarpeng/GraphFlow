import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { previewContext } from "../src/surfaces/cli/runtime";
import { buildExecutionDescriptor } from "../src/core/orchestrator-phases";

/**
 * P0 wiring tests for the opt-in SoL-Pi-style efficiency mechanisms:
 * - GF-3: observed-pressure budget + compaction signal in graphflow_context preview.
 * - GF-4: fused edit+validate steps on the bridge executionDescriptor.
 */

function writeConfig(root: string, storePath: string, withEfficiency: boolean): string {
  const configPath = join(root, "graphflow.config.json");
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
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: storePath,
          maxContextTokens: 1000,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
        ...(withEfficiency
          ? {
              efficiencyPolicy: {
                contextPressure: { enabled: true, maxContextTokens: "auto", cacheWriteReadRatio: 12.5 },
                actionFusion: { enabled: true },
              },
            }
          : {
              efficiencyPolicy: {
                observations: { enabled: false },
                contextPressure: { enabled: false },
                actionFusion: { enabled: false },
              },
            }),
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
}

describe("GF-3 observed-pressure budget and compaction signal", () => {
  const enabledRoot = mkdtempSync(join(tmpdir(), "graphflow-gf3-on-"));
  const disabledRoot = mkdtempSync(join(tmpdir(), "graphflow-gf3-off-"));
  const enabledConfig = writeConfig(enabledRoot, join(enabledRoot, "graph.json"), true);
  const disabledConfig = writeConfig(disabledRoot, join(disabledRoot, "graph.json"), false);

  afterAll(() => {
    rmSync(enabledRoot, { recursive: true, force: true });
    rmSync(disabledRoot, { recursive: true, force: true });
  });

  it("scales the packed budget by observed pressure and emits a compaction signal", async () => {
    const preview = await previewContext(
      "demo query",
      enabledConfig,
      enabledRoot,
      undefined,
      { recordDialogue: false },
      { usedTokens: 50, maxTokens: 100, remainingTurnsEstimate: 10 }
    );

    expect(preview.contextPressure).toBeDefined();
    expect(preview.contextPressure?.budgetMode).toBe("auto");
    // defaultMax 1000 * pressure 0.5 = 500
    expect(preview.contextPressure?.effectiveMaxContextTokens).toBe(500);
    expect(preview.contextPressure?.pressureRatio).toBeCloseTo(0.5);
    expect(preview.tokenBudget.maxContextTokens).toBe(500);
    expect(preview.contextPressure?.compaction).toBeDefined();
    expect(preview.contextPressure?.compaction?.boundaryLabel).toContain("demo query");
  });

  it("falls back to the default budget when no observation is supplied", async () => {
    const preview = await previewContext("demo query", enabledConfig, enabledRoot, undefined, {
      recordDialogue: false,
    });

    expect(preview.contextPressure?.effectiveMaxContextTokens).toBe(1000);
    expect(preview.contextPressure?.usedTokens).toBeUndefined();
    expect(preview.contextPressure?.compaction).toBeUndefined();
    expect(preview.tokenBudget.maxContextTokens).toBe(1000);
  });

  it("emits no pressure block when the mechanism is disabled", async () => {
    const preview = await previewContext(
      "demo query",
      disabledConfig,
      disabledRoot,
      undefined,
      { recordDialogue: false },
      { usedTokens: 50, maxTokens: 100, remainingTurnsEstimate: 10 }
    );

    expect(preview.contextPressure).toBeUndefined();
    expect(preview.tokenBudget.maxContextTokens).toBe(1000);
  });
});

describe("GF-4 fused steps on the bridge executionDescriptor", () => {
  const planProjection = [
    { id: "t1", description: "Edit src/foo.ts to add the flag", dependencies: [] },
    { id: "t2", description: "Run the unit tests", dependencies: ["t1"] },
  ];

  it("omits steps when Action Fusion is disabled", () => {
    const descriptor = buildExecutionDescriptor({
      task: "add flag",
      planProjection,
      agentAssignments: [],
      contextStr: "",
      retryHints: [],
      delegatedExtras: {},
    });
    expect(descriptor.steps).toBeUndefined();
    expect(descriptor.fused).toBeUndefined();
  });

  it("attaches fused edit+validate steps when enabled", () => {
    const descriptor = buildExecutionDescriptor({
      task: "add flag",
      planProjection,
      agentAssignments: [],
      contextStr: "",
      retryHints: [],
      delegatedExtras: {},
      enableActionFusion: true,
    });
    expect(descriptor.fused).toBe(true);
    expect(descriptor.steps?.[0]).toMatchObject({ action: "edit", command: "Run the unit tests" });
  });
});
