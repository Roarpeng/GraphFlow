import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/config/loader";
import type { GraphFlowConfig } from "../src/config/schema";
import {
  appendCostEvent,
  readCostEvents,
  resetCostLedgerForTests,
  summarizeCost,
  type CostEvent,
} from "../src/learning/cost-ledger";
import {
  CACHE_READ_FACTOR,
  estimateCostMgc,
  lookupPrice,
} from "../src/routing/model-prices";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  loadEpisode,
  recordEpisode,
  updateEpisodeOutcome,
} from "../src/learning/episodic-memory";

describe("M-cost-ledger (U1)", () => {
  let tmpDir: string;
  let ledgerPath: string;
  let config: GraphFlowConfig;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "GRAPHFLOW_PRICE_DEEPSEEK",
    "GRAPHFLOW_PRICE_DEEPSEEK_DEEPSEEK_V4_PRO",
    "GRAPHFLOW_PRICE_OPENAI",
  ];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gf-cost-ledger-"));
    ledgerPath = join(tmpDir, "cost-ledger.jsonl");
    resetCostLedgerForTests(ledgerPath);
    config = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: false,
        transport: "memory",
        workspaceRoot: tmpDir,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetCostLedgerForTests();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function llmEvent(overrides: Partial<CostEvent> & { ts: string }): CostEvent {
    return { kind: "llm", ...overrides };
  }

  it("A: lookupPrice serves the table, env overrides, and model-prefix precedence", () => {
    // Built-in table (DeepSeek official RMB approximations).
    expect(lookupPrice("deepseek", "deepseek-v4-pro")).toEqual({ promptPerM: 4, completionPerM: 16 });
    expect(lookupPrice("deepseek", "deepseek-chat")).toEqual({ promptPerM: 2, completionPerM: 8 });
    // Longest model prefix wins even with trailing version tags.
    const mini = lookupPrice("openai", "gpt-4.1-mini-2025-04-14");
    expect(mini).toEqual({ promptPerM: 2.88, completionPerM: 11.52 });

    // Provider-level env override beats the table...
    process.env.GRAPHFLOW_PRICE_DEEPSEEK = "9,9";
    expect(lookupPrice("deepseek", "deepseek-chat")).toEqual({ promptPerM: 9, completionPerM: 9 });
    // ...and the model-prefix env override beats the provider-level one.
    process.env.GRAPHFLOW_PRICE_DEEPSEEK_DEEPSEEK_V4_PRO = "5,25";
    expect(lookupPrice("deepseek", "deepseek-v4-pro")).toEqual({ promptPerM: 5, completionPerM: 25 });
    // Unrelated model still resolves via the provider-level override.
    expect(lookupPrice("deepseek", "deepseek-reasoner")).toEqual({ promptPerM: 9, completionPerM: 9 });

    // Unknown provider/model has no price.
    expect(lookupPrice("custom", "my-model")).toBeUndefined();
  });

  it("B: localhost baseUrls price at zero (local judgment layer is free)", () => {
    expect(lookupPrice("deepseek", "deepseek-chat", "http://localhost:8000/v1")).toEqual({
      promptPerM: 0,
      completionPerM: 0,
    });
    expect(lookupPrice("openai", "gpt-4.1", "http://127.0.0.1:11434/v1")).toEqual({
      promptPerM: 0,
      completionPerM: 0,
    });
    // Env overrides do not sneak past the local check.
    process.env.GRAPHFLOW_PRICE_DEEPSEEK = "9,9";
    expect(lookupPrice("deepseek", "deepseek-chat", "http://localhost:8000")).toEqual({
      promptPerM: 0,
      completionPerM: 0,
    });
    // Remote endpoints stay priced (here by the env override).
    expect(lookupPrice("deepseek", "deepseek-chat", "https://api.deepseek.com")?.promptPerM).toBe(9);
  });

  it("C: estimateCostMgc bills cache hits at promptPerM*0.1 and rounds to 0.0001", () => {
    expect(CACHE_READ_FACTOR).toBe(0.1);
    const price = { promptPerM: 4, completionPerM: 16 };

    // No cache: (1000*4 + 1000*16) / 1e6 = 0.02
    expect(estimateCostMgc(1000, 1000, 0, price)).toBeCloseTo(0.02, 8);
    // All cache hit: (1000*4*0.1 + 1000*16) / 1e6 = 0.0164
    expect(estimateCostMgc(1000, 1000, 1000, price)).toBeCloseTo(0.0164, 8);
    // Partial: (800*4 + 200*0.4 + 500*16) / 1e6 = 0.00564 → rounds to 0.0056
    expect(estimateCostMgc(1000, 500, 200, { promptPerM: 2, completionPerM: 8 })).toBeCloseTo(
      0.0056,
      8
    );
    // cacheHitTokens beyond promptTokens is clamped, never negative-billed.
    expect(estimateCostMgc(500, 0, 1000, price)).toBeCloseTo(0.0002, 8);
  });

  it("D: appendCostEvent appends, readCostEvents round-trips, malformed lines are skipped", () => {
    expect(existsSync(ledgerPath)).toBe(false);
    appendCostEvent(
      config,
      llmEvent({
        ts: "2026-10-01T00:00:00.000Z",
        role: "planner",
        tier: "economy",
        provider: "deepseek",
        model: "deepseek-chat",
        promptTokens: 100,
        completionTokens: 50,
        cacheHitTokens: 20,
      })
    );
    appendCostEvent(
      config,
      llmEvent({
        ts: "2026-10-01T00:00:01.000Z",
        role: "worker",
        tier: "smart",
        provider: "openai",
        model: "gpt-4.1",
        promptTokens: 200,
        completionTokens: 80,
      })
    );
    appendCostEvent(config, {
      ts: "2026-10-01T00:00:02.000Z",
      kind: "deliver",
      deliveredBytes: 4096,
    });

    const events = readCostEvents(config);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "llm", provider: "deepseek", promptTokens: 100 });
    expect(events[2]).toMatchObject({ kind: "deliver", deliveredBytes: 4096 });

    // A torn final line and a structurally-invalid kind are skipped, not fatal.
    writeFileSync(
      ledgerPath,
      [readFileSync(ledgerPath, "utf8"), "{not json", JSON.stringify({ ts: "x", kind: "other" }), ""].join("\n"),
      "utf8"
    );
    expect(readCostEvents(config)).toHaveLength(3);
  });

  it("E: governance trims a >4000-line ledger to the newest 2000 on append", () => {
    // Seed 4005 valid lines directly (marker in sessionId), then append one.
    const seedLines: string[] = [];
    for (let i = 0; i < 4005; i += 1) {
      seedLines.push(
        JSON.stringify(
          llmEvent({
            ts: "2026-10-01T00:00:00.000Z",
            provider: "deepseek",
            model: "deepseek-chat",
            sessionId: `seed-${i}`,
          })
        )
      );
    }
    writeFileSync(ledgerPath, `${seedLines.join("\n")}\n`, "utf8");

    appendCostEvent(
      config,
      llmEvent({
        ts: "2026-10-02T00:00:00.000Z",
        provider: "deepseek",
        model: "deepseek-chat",
        sessionId: "final-marker",
      })
    );

    const events = readCostEvents(config);
    expect(events).toHaveLength(2000);
    // Newest retained: the freshly appended event.
    expect(events[events.length - 1]?.sessionId).toBe("final-marker");
    // The window starts at seed-2006 (4006 lines total - 2000 kept).
    expect(events[0]?.sessionId).toBe("seed-2006");
    // The oldest seeds were dropped.
    expect(events.some((event) => event.sessionId === "seed-0")).toBe(false);
  });

  it("F: summarizeCost aggregates tokens, prices events, and counts unpriced calls", () => {
    appendCostEvent(
      config,
      llmEvent({
        ts: new Date().toISOString(),
        provider: "deepseek",
        model: "deepseek-chat",
        promptTokens: 1000,
        completionTokens: 500,
        cacheHitTokens: 200,
      })
    );
    appendCostEvent(
      config,
      llmEvent({
        ts: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4.1",
        promptTokens: 2000,
        completionTokens: 1000,
      })
    );
    // Unpriced provider/model: counted, but contributes 0 cost.
    appendCostEvent(
      config,
      llmEvent({
        ts: new Date().toISOString(),
        provider: "custom",
        model: "my-model",
        promptTokens: 10,
        completionTokens: 10,
      })
    );
    // Delivery events carry bytes, not tokens.
    appendCostEvent(config, { ts: new Date().toISOString(), kind: "deliver", deliveredBytes: 512 });
    // One-hour-old event: only visible without a sinceMs filter.
    appendCostEvent(
      config,
      llmEvent({
        ts: new Date(Date.now() - 3600_000).toISOString(),
        provider: "deepseek",
        model: "deepseek-chat",
        promptTokens: 7,
        completionTokens: 7,
        sessionId: "stale",
      })
    );

    const all = summarizeCost(config);
    expect(all.calls).toBe(5);
    expect(all.promptTokens).toBe(3017);
    expect(all.completionTokens).toBe(1517);
    expect(all.cacheHitTokens).toBe(200);
    expect(all.unpricedCalls).toBe(1);
    // deepseek-chat (2/8): (800*2 + 200*0.2 + 500*8)/1e6 = 0.0056
    // gpt-4.1 (14.4/57.6): (2000*14.4 + 1000*57.6)/1e6 = 0.0864
    // stale deepseek-chat: (7*2 + 7*8)/1e6 = 0.00007 → rounds to 0.0001 at the end
    expect(all.estCostMgc).toBeCloseTo(0.0056 + 0.0864 + 0.0001, 6);

    const llmOnly = summarizeCost(config, { kind: "llm" });
    expect(llmOnly.calls).toBe(4);
    expect(llmOnly.unpricedCalls).toBe(1);

    const deliverOnly = summarizeCost(config, { kind: "deliver" });
    expect(deliverOnly.calls).toBe(1);
    expect(deliverOnly.estCostMgc).toBe(0);

    const recent = summarizeCost(config, { sinceMs: 60_000 });
    expect(recent.calls).toBe(4);
    expect(recent.promptTokens).toBe(3010);
  });

  it("G: updateEpisodeOutcome persists costSummary on a GraphifyClient in-memory graph", async () => {
    const client = new GraphifyClient();
    const episode = await recordEpisode(client, {
      task: "add cost ledger module",
      plan: [{ id: "t1", description: "write ledger" }],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });

    const updated = await updateEpisodeOutcome(
      client,
      episode.id,
      "pass",
      ["prices need env overrides"],
      "none",
      undefined,
      { promptTokens: 3000, completionTokens: 1200, cacheHitTokens: 800, calls: 6 }
    );
    expect(updated?.costSummary).toEqual({
      promptTokens: 3000,
      completionTokens: 1200,
      cacheHitTokens: 800,
      calls: 6,
    });

    // Persisted through the graph node, not just the return value.
    const reloaded = await loadEpisode(client, episode.id);
    expect(reloaded?.costSummary).toEqual({
      promptTokens: 3000,
      completionTokens: 1200,
      cacheHitTokens: 800,
      calls: 6,
    });
    expect(reloaded?.outcome).toBe("pass");

    // Omitting costSummary leaves a previously persisted summary untouched
    // ("不传时行为不变" — the stored bill survives later outcome updates).
    const second = await updateEpisodeOutcome(client, episode.id, "fail", ["no"]);
    expect(second?.costSummary).toEqual({
      promptTokens: 3000,
      completionTokens: 1200,
      cacheHitTokens: 800,
      calls: 6,
    });
    expect(second?.outcome).toBe("fail");
  });
});
