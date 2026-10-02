import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve";
import {
  buildEfficiencyAdvisory,
  decideModelTier,
  decideReuseMode,
  deriveValidation,
  extractExecutableCommand,
  extractInlinedAnchorIds,
} from "../src/core/efficiency-advisory";
import {
  appendDecisionLedgerRecord,
  readDecisionLedger,
  resolveDecisionLedgerPath,
  summarizeDecisionLedger,
} from "../src/learning/decision-ledger";

describe("efficiency advisory (deterministic Layer A)", () => {
  it("identical inputs produce identical advisories (minus measured duration)", () => {
    const input = {
      task: "修复 axis 回零异常 并 验证 build",
      taskComplexity: "complex" as const,
      executionMode: "bridge" as const,
      fusedSteps: [
        { id: "s1", action: "edit" as const, target: "src/motion.ts" },
        { id: "s2", action: "validate" as const, command: "npm run build" },
      ],
      similarEpisodes: [{ id: "ep1", task: "修复 axis 异常", score: 0.7 }],
      durationMs: 3,
    };
    const a = buildEfficiencyAdvisory(input);
    const b = buildEfficiencyAdvisory(input);
    expect({ ...a, decision: { ...a.decision, durationMs: 0 } }).toEqual({
      ...b,
      decision: { ...b.decision, durationMs: 0 },
    });
    expect(a.mode).toBe("shadow");
    expect(a.decision.provenance).toBe("deterministic");
    expect(a.decision.llmCalls).toBe(0);
    expect(a.validation).toEqual(["npm run build"]);
    expect(a.reuseMode).toBe("ADAPT");
  });

  it("reuses conservatively: no qualifying episode → FRESH, qualifying → ADAPT, REUSE unreachable", () => {
    expect(decideReuseMode([]).reuseMode).toBe("FRESH");
    expect(decideReuseMode([{ score: 0.3 }]).reuseMode).toBe("FRESH");
    const adapt = decideReuseMode([{ score: 0.5 }, { score: 0.9 }]);
    expect(adapt.reuseMode).toBe("ADAPT");
    expect(adapt.confidence).toBeGreaterThan(0.55);
    expect(adapt.confidence).toBeLessThanOrEqual(0.8);
  });

  it("gates ADAPT on text similarity, not on the outcome score", () => {
    // Outcome pass (score 1) on a barely-related episode must NOT qualify...
    expect(decideReuseMode([{ score: 1, similarity: 0.14 }]).reuseMode).toBe("FRESH");
    // ...while a pending episode (score 0) that is genuinely similar does.
    const bySimilarity = decideReuseMode([{ score: 0, similarity: 0.6 }]);
    expect(bySimilarity.reuseMode).toBe("ADAPT");
    expect(bySimilarity.qualifyingMetric).toBe("similarity");
    // Mixed signals: one similarity-qualifier outweighs any number of
    // score-only qualifiers (similarity is the primary gate).
    const mixed = decideReuseMode([{ score: 1, similarity: 0.2 }, { score: 1, similarity: 0.7 }]);
    expect(mixed.reuseMode).toBe("ADAPT");
    expect(mixed.qualifyingMetric).toBe("similarity");
    // Legacy callers without similarity still work through the score gate.
    const legacy = decideReuseMode([{ score: 1 }]);
    expect(legacy.reuseMode).toBe("ADAPT");
    expect(legacy.qualifyingMetric).toBe("score");
  });

  it("maps complexity to the cheapest matching tier and never escalates to heavy", () => {
    expect(decideModelTier("simple")).toBe("economy");
    expect(decideModelTier("complex")).toBe("standard");
  });

  it("derives validation gates from validate-classified fused steps only", () => {
    expect(
      deriveValidation([
        { id: "s1", action: "edit", target: "a.ts" },
        { id: "s2", action: "validate", command: "npm test" },
        { id: "s3", action: "validate", command: "npm test" },
      ])
    ).toEqual(["npm test"]);
  });

  it("never ships plan prose as a validation gate", () => {
    const proseOnly = [
      { id: "s1", action: "edit" as const, target: "实现: X", command: "验证: Fix the embedding provider" },
      { id: "s2", action: "validate" as const, command: "check that recall works" },
    ];
    expect(deriveValidation(proseOnly)).toEqual([]);
    expect(deriveValidation(proseOnly, ["npm run typecheck", "npm test"])).toEqual([
      "npm run typecheck",
      "npm test",
    ]);
    expect(
      deriveValidation([{ id: "s1", action: "validate", command: "then run `npx vitest run tests/a.test.ts`" }])
    ).toEqual(["npx vitest run tests/a.test.ts"]);
    // Query-only plans (no edit step) get no project gates.
    expect(deriveValidation([], ["npm test"])).toEqual([]);
  });

  it("extracts the anchor ids a descriptor inlined as source excerpts", () => {
    const context = [
      "### src/a.ts:1 [anchor symbol:src/a.ts:abc]",
      "### src/b.ts:9 (truncated) [anchor symbol:src/b.ts:def]",
      "### src/a.ts:1 [anchor symbol:src/a.ts:abc]",
    ].join("\n");
    expect(extractInlinedAnchorIds(context)).toEqual(["symbol:src/a.ts:abc", "symbol:src/b.ts:def"]);
    expect(extractInlinedAnchorIds(undefined)).toEqual([]);
    expect(extractExecutableCommand("验证: npm test")).toBeUndefined();
    expect(extractExecutableCommand("npm run build")).toBe("npm run build");
  });

  it("advisory surfaces episode signals and anchor budget", () => {
    const advisory = buildEfficiencyAdvisory({
      task: "add config loader",
      taskComplexity: "simple",
      executionMode: "bridge",
      requiredAnchors: ["file:src/config/paths.ts"],
      maxContextTokens: 3200,
      durationMs: 1,
    });
    expect(advisory.reuseMode).toBe("FRESH");
    expect(advisory.worker).toEqual({ modelTier: "economy", executionMode: "one-shot", maxRounds: 1 });
    expect(advisory.context.requiredAnchors).toEqual(["file:src/config/paths.ts"]);
    expect(advisory.context.maxTokens).toBe(3200);
  });
});

describe("decision-cost ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-ledger-"));
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
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: join(root, "store.json"),
          maxContextTokens: 400,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
      },
      null,
      2
    ),
    "utf8"
  );

  afterEach(() => {
    delete process.env.GRAPHFLOW_DECISION_LEDGER;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("appends, reads back, and summarizes decision records", () => {
    const config = resolveConfig(configPath);
    const path = resolveDecisionLedgerPath(config);
    expect(path).toBe(join(root, "graphflow-out", "decision-ledger.jsonl"));

    const appended = appendDecisionLedgerRecord(config, {
      kind: "decision",
      at: "2026-09-30T00:00:00.000Z",
      taskId: "task:abc",
      tool: "graphflow_run",
      mode: "shadow",
      reuseMode: "FRESH",
      modelTier: "economy",
      durationMs: 2,
      llmCalls: 0,
      tokenCost: 0,
      provenance: "deterministic",
    });
    expect(appended).toEqual({ path, appended: true });
    expect(existsSync(path)).toBe(true);

    const records = readDecisionLedger(path);
    expect(records).toHaveLength(1);
    expect(records[0]!.taskId).toBe("task:abc");

    const summary = summarizeDecisionLedger(records);
    expect(summary.count).toBe(1);
    expect(summary.totalLlmCalls).toBe(0);
    expect(summary.byReuseMode.FRESH).toBe(1);
  });

  it("respects GRAPHFLOW_DECISION_LEDGER=0 and tolerates torn final lines", () => {
    const config = resolveConfig(configPath);
    process.env.GRAPHFLOW_DECISION_LEDGER = "0";
    const skipped = appendDecisionLedgerRecord(config, {
      kind: "decision",
      at: "2026-09-30T00:00:01.000Z",
      taskId: "task:def",
      tool: "graphflow_run",
      mode: "shadow",
      reuseMode: "ADAPT",
      modelTier: "standard",
      durationMs: 1,
      llmCalls: 0,
      tokenCost: 0,
      provenance: "deterministic",
    });
    expect(skipped).toEqual({ path: resolveDecisionLedgerPath(config), skipped: "disabled" });

    // A crash-torn last line must not corrupt reads of prior records.
    const path = resolveDecisionLedgerPath(config);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, `${raw}{"kind":"decision","at":"tor`, "utf8");
    expect(readDecisionLedger(path)).toHaveLength(1);
  });
});
