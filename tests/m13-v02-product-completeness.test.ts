import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { diagnoseRouting, runLearningNightly, runTask } from "../src/surfaces/cli/runtime";

describe("M13 v0.2 product completeness", () => {
  it("indexes module and import relations for higher graph quality", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-m13-index-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "import { b } from './b'; export function a() { return b(); }", "utf8");
      writeFileSync(join(root, "src", "b.ts"), "export function b() { return 1; }", "utf8");

      const client = new GraphifyClient();
      const result = await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"] });
      const snapshot = client.snapshot();

      expect(result.indexedFiles).toBeGreaterThanOrEqual(2);
      expect(snapshot.nodes.some((node) => node.type === "Module")).toBe(true);
      expect(snapshot.edges.some((edge) => edge.relation === "imports")).toBe(true);
      expect(snapshot.edges.some((edge) => edge.relation === "defines")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports dynamic routing diagnostics with strict provider health", () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-m13-route-"));
    const configPath = join(root, "graphflow.config.json");

    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            providers: {
              openai: {},
              anthropic: { apiKey: "anthropic-key" },
              bailian: {},
              doubao: {},
            },
            tiers: {
              smart: { provider: "openai", model: "gpt-5.3-codex" },
              economy: { provider: "openai", model: "gpt-4.1-mini" },
            },
            budgetPolicy: { runTokenCap: 2000 },
            graphPolicy: {
              enableAutoBuild: true,
              transport: "memory",
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: join(root, "learning.jsonl"),
            },
            routingPolicy: {
              enableDynamicRouting: true,
              requireApiKeyForHealthy: true,
              providerPriority: ["anthropic", "openai", "bailian", "doubao"],
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const output = diagnoseRouting(configPath);
      expect(output).toContain("dynamicRouting=on");
      expect(output).toContain("openai:false");
      expect(output).toContain("anthropic:true");
      expect(output).toContain("planner=anthropic/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs nightly learning cycle from persisted feedback events", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-m13-learn-"));
    const configPath = join(root, "graphflow.config.json");
    const eventsPath = join(root, "events.jsonl");
    const exportPath = join(root, "dataset.jsonl");
    const summaryPath = join(root, "summary.json");

    try {
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
              autoIndexOnRun: false,
              transport: "memory",
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath,
              eventsPath,
              summaryPath,
            },
            routingPolicy: {
              enableDynamicRouting: false,
            },
          },
          null,
          2
        ),
        "utf8"
      );

      await runTask("health check", configPath);
      await runTask("update readme and add tests", configPath);

      const output = runLearningNightly(configPath);
      expect(output).toContain("events=2");
      expect(output).toContain("dataset=");
      expect(existsSync(exportPath)).toBe(true);
      expect(existsSync(summaryPath)).toBe(true);
      expect(readFileSync(exportPath, "utf8")).toContain("#metrics");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
