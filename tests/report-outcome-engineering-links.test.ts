import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";
import { reportOutcome, runTaskResult } from "../src/surfaces/cli/runtime";
import { createGraphClient } from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import { getToolDefinitions } from "../src/surfaces/mcp/tool-definitions";
import { buildCliUsage } from "../src/surfaces/cli/output";
import type { GraphNode } from "../src/core/types";

describe("reportOutcome Engineering KG wiring", () => {
  it("MCP + CLI surfaces expose optional eng-link fields", () => {
    const def = getToolDefinitions().find((t) => t.name === "graphflow_report_outcome");
    expect(def).toBeDefined();
    const props = def!.inputSchema.properties as Record<string, unknown>;
    expect(props.requirementIds).toBeDefined();
    expect(props.conceptIds).toBeDefined();
    expect(props.codeHints).toBeDefined();

    const usage = buildCliUsage();
    expect(usage).toContain("--requirement-id");
    expect(usage).toContain("--concept-id");
    expect(usage).toContain("--code-hint");
  });

  it("reportOutcome writes episode → derived_from → Requirement/Concept/code", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-outcome-eng-"));
    const storePath = join(root, "graph.json");
    const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;

    try {
      process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = "1000";
      writeFileSync(join(root, "tokenizer.ts"), "export function tokenize() {}\n", "utf8");

      const configPath = createNoLlmConfigPath({
        graphPolicy: {
          enableAutoBuild: true,
          enableNearLosslessMode: true,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: storePath,
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
        skillPolicy: {
          enableSkillFlywheel: false,
          maxSkillHints: 2,
        },
        routingPolicy: {
          enableDynamicRouting: false,
          requireApiKeyForHealthy: true,
        },
      });

      const runResult = await runTaskResult("wire episode to eng kg", configPath);
      expect(runResult.episodeId).toBeTruthy();
      const episodeId = runResult.episodeId!;

      const requirementId = "requirement:must-cache";
      const conceptId = "concept:tokenizer-cache";
      const engNodes: GraphNode[] = [
        {
          id: requirementId,
          type: "Requirement",
          content: "Must cache tokenizer results",
          metadata: { domain: "doc", kind: "requirement" },
        },
        {
          id: conceptId,
          type: "Concept",
          content: "TokenizerCache",
          metadata: { domain: "doc", kind: "concept" },
        },
        {
          id: "file:tokenizer.ts",
          type: "File",
          content: "tokenizer.ts",
        },
      ];

      const client = createGraphClient(resolveConfig(configPath));
      await client.upsertNodes(engNodes);

      const reported = await reportOutcome(
        episodeId,
        true,
        ["prefer derived_from eng links"],
        configPath,
        "none",
        {
          requirementIds: [requirementId],
          conceptIds: [conceptId],
          codeHints: ["tokenizer.ts"],
        }
      );

      expect(reported.ok).toBe(true);
      expect(reported.outcome).toBe("pass");
      expect(reported.engineeringLinks?.edgeCount).toBe(3);
      expect(reported.engineeringLinks?.linkedRequirementIds).toEqual([requirementId]);
      expect(reported.engineeringLinks?.linkedConceptIds).toEqual([conceptId]);
      expect(reported.engineeringLinks?.linkedCodeNodeIds).toEqual(["file:tokenizer.ts"]);

      const snap = createGraphClient(resolveConfig(configPath)).readSnapshot!();
      const derived = snap.edges.filter(
        (e) => e.from === episodeId && e.relation === "derived_from"
      );
      expect(derived).toEqual(
        expect.arrayContaining([
          { from: episodeId, to: requirementId, relation: "derived_from" },
          { from: episodeId, to: conceptId, relation: "derived_from" },
          { from: episodeId, to: "file:tokenizer.ts", relation: "derived_from" },
        ])
      );
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("reportOutcome without eng hints omits engineeringLinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-outcome-plain-"));
    const storePath = join(root, "graph.json");
    const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;

    try {
      process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = "1000";
      const configPath = createNoLlmConfigPath({
        graphPolicy: {
          enableAutoBuild: true,
          enableNearLosslessMode: true,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: storePath,
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
        skillPolicy: { enableSkillFlywheel: false, maxSkillHints: 2 },
        routingPolicy: { enableDynamicRouting: false, requireApiKeyForHealthy: true },
      });

      const runResult = await runTaskResult("plain outcome", configPath);
      const reported = await reportOutcome(
        runResult.episodeId!,
        false,
        ["no eng hints"],
        configPath
      );
      expect(reported.ok).toBe(true);
      expect(reported.engineeringLinks).toBeUndefined();
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
