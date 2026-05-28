import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import {
  buildLayeredContextPackage,
  createContextRefillManager,
} from "../src/graph/context-slicer";

const baseConfig = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-5.3-codex" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 200,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly",
    canaryRatio: 10,
    exportPath: "tmp/learning-dataset.jsonl",
  },
});

describe("M8 near-lossless token compression", () => {
  it("builds dual-channel package under budget", async () => {
    const client = createGraphClient(baseConfig);
    await client.upsertNodes([
      { id: "file:readme", type: "File", content: "README contains architecture overview" },
      { id: "symbol:orchestrate", type: "Symbol", content: "orchestrate handles task routing" },
      { id: "decision:token", type: "Decision", content: "prefer summary + anchor channel" },
    ]);

    const pkg = await buildLayeredContextPackage(client, "orchestrate", 40);

    expect(pkg.summaryChannel.length).toBeGreaterThan(0);
    expect(pkg.anchorChannel.length).toBeGreaterThan(0);
    expect(pkg.tokenEstimate).toBeLessThanOrEqual(40);
  });

  it("respects L1/L2/L3 quotas", async () => {
    const client = createGraphClient(baseConfig);
    await client.upsertNodes([
      { id: "file:a", type: "File", content: "module alpha" },
      { id: "symbol:a", type: "Symbol", content: "module alpha function" },
      { id: "module:a", type: "Module", content: "module alpha aggregate" },
      { id: "decision:a", type: "Decision", content: "module alpha design" },
      { id: "taskrun:a", type: "TaskRun", content: "module alpha historical run" },
    ]);

    const pkg = await buildLayeredContextPackage(client, "module", 200, {
      layerQuota: { l1: 1, l2: 1, l3: 1 },
    });

    const l1Count = pkg.anchorChannel.filter((item) => item.layer === "L1").length;
    const l2Count = pkg.anchorChannel.filter((item) => item.layer === "L2").length;
    const l3Count = pkg.anchorChannel.filter((item) => item.layer === "L3").length;

    expect(l1Count).toBeLessThanOrEqual(1);
    expect(l2Count).toBeLessThanOrEqual(1);
    expect(l3Count).toBeLessThanOrEqual(1);
  });

  it("supports dynamic refill without duplicate anchors", async () => {
    const client = createGraphClient(baseConfig);
    await client.upsertNodes([
      { id: "symbol:router", type: "Symbol", content: "router chooses model by tier" },
      { id: "decision:router", type: "Decision", content: "router fallback when provider unhealthy" },
      { id: "symbol:validator", type: "Symbol", content: "validator checks requirement alignment" },
    ]);

    const refill = createContextRefillManager(client, 60);
    const initial = await refill.initialPackage("router");
    const extra = await refill.refill(["validator", "fallback"]);

    const initialIds = new Set(initial.anchorChannel.map((item) => item.id));
    const duplicate = extra.some((line) => {
      return Array.from(initialIds).some((id) => line.includes(id));
    });

    expect(initial.summaryChannel.length).toBeGreaterThan(0);
    expect(extra.length).toBeGreaterThan(0);
    expect(duplicate).toBe(false);
  });
});
