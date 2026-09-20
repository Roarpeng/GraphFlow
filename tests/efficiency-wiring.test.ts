import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { previewContext } from "../src/surfaces/cli/runtime";
import { buildExecutionDescriptor } from "../src/core/orchestrator-phases";

/**
 * P0 wiring tests for the SoL-Pi-style efficiency mechanisms (best config:
 * every mechanism ON by default, only an explicit `false` switches one off):
 * - GF-3: observed-pressure budget + compaction signal in graphflow_context preview.
 * - GF-4: fused edit+validate steps on the bridge executionDescriptor.
 */

type EfficiencyMode = "on" | "off" | "absent";

function writeConfig(root: string, storePath: string, mode: EfficiencyMode): string {
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
        ...(mode === "on"
          ? {
              efficiencyPolicy: {
                contextPressure: { enabled: true, maxContextTokens: "auto", cacheWriteReadRatio: 12.5 },
                actionFusion: { enabled: true },
              },
            }
          : mode === "off"
          ? {
              efficiencyPolicy: {
                observations: { enabled: false },
                contextPressure: { enabled: false },
                actionFusion: { enabled: false },
              },
            }
          : {}),
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
  const absentRoot = mkdtempSync(join(tmpdir(), "graphflow-gf3-absent-"));
  const enabledConfig = writeConfig(enabledRoot, join(enabledRoot, "graph.json"), "on");
  const disabledConfig = writeConfig(disabledRoot, join(disabledRoot, "graph.json"), "off");
  const absentConfig = writeConfig(absentRoot, join(absentRoot, "graph.json"), "absent");

  afterAll(() => {
    rmSync(enabledRoot, { recursive: true, force: true });
    rmSync(disabledRoot, { recursive: true, force: true });
    rmSync(absentRoot, { recursive: true, force: true });
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

  it("carries the economic compaction verdict when remainingTurnsEstimate is supplied", async () => {
    // Deferral case: pressure exactly 0.5 is not "under pressure" (> 0.5).
    // Economics for the record: compact = read 5 + write 12.5*12.5 + replay
    // 10*12.5*0.1 = 173.75 vs replay 10*50*0.1 = 50 → saving -123.75, but the
    // pressure gate defers before economics even apply.
    const deferred = await previewContext(
      "demo query",
      enabledConfig,
      enabledRoot,
      undefined,
      { recordDialogue: false },
      { usedTokens: 50, maxTokens: 100, remainingTurnsEstimate: 10 }
    );
    const deferredSignal = deferred.contextPressure?.compaction;
    expect(deferredSignal).toBeDefined();
    expect(deferredSignal?.recommend).toBe(false);
    expect(deferredSignal?.projectedSaving).toBeCloseTo(-123.75, 6);
    expect(deferredSignal?.reason).toContain("deferred");
    expect(deferredSignal?.continuationContext).toBe("demo query");

    // Recommendation case: pressure 0.6, 200 turns left. Replay
    // 200 * 60000 * 0.1 = 1,200,000 vs compact 6000 + 15000*12.5 + 200*15000*0.1
    // = 493,500 → projected saving 706,500 (58.9% of replay cost) clears
    // minSavingRatio 0.2.
    const recommended = await previewContext(
      "demo query",
      enabledConfig,
      enabledRoot,
      undefined,
      { recordDialogue: false },
      { usedTokens: 60_000, maxTokens: 100_000, remainingTurnsEstimate: 200 }
    );
    const signal = recommended.contextPressure?.compaction;
    expect(signal).toBeDefined();
    expect(signal?.recommend).toBe(true);
    expect(signal?.projectedSaving).toBe(706_500);
    expect(signal?.reason).toContain("clears minSavingRatio 0.20");
    expect(recommended.contextPressure?.pressureRatio).toBeCloseTo(0.6);
    expect(recommended.contextPressure?.effectiveMaxContextTokens).toBe(600);
  });

  it("stays on when the config has no efficiencyPolicy section at all (best-by-default)", async () => {
    const preview = await previewContext(
      "demo query",
      absentConfig,
      absentRoot,
      undefined,
      { recordDialogue: false },
      { usedTokens: 50, maxTokens: 100, remainingTurnsEstimate: 10 }
    );

    // An absent section is not an explicit false: the mechanism stays enabled
    // and the pressure block is still emitted.
    expect(preview.contextPressure).toBeDefined();
    expect(preview.contextPressure?.enabled).toBe(true);
    expect(preview.contextPressure?.effectiveMaxContextTokens).toBe(500);
    expect(preview.contextPressure?.compaction).toBeDefined();
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
