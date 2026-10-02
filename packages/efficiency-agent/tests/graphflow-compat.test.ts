import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { getToolDefinitions } from "../../../src/surfaces/mcp/tool-definitions";
import { buildEfficiencyAdvisory, extractInlinedAnchorIds } from "../../../src/core/efficiency-advisory";
import { loadEfficiencyPolicy, readDecisionLedger } from "../../../src/learning/decision-ledger";
import type { GraphFlowConfig } from "../../../src/config/schema";
import { assertAdvisoryCompatible } from "../src/contract";
import { anchorFilesFromIds } from "../src/host/graphflow-mcp-client";
import { graphArtifactVersion } from "../src/host/project-facts";
import { learnPolicyFromLedger, trajectoryFromLedger } from "../src/learning/policy-from-ledger";

/**
 * Substrate compatibility contract (docs/GRAPHFLOW_COMPATIBILITY.md). Each
 * block pins one surface the efficiency agent consumes; a failure here means
 * the substrate broke a frozen surface and needs a deprecation + major bump.
 * No server spawn: tool definitions and advisory builders are pure.
 */

const tools = getToolDefinitions();
const byName = new Map(tools.map((tool) => [tool.name, tool]));

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "eff-compat-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("S1 MCP tool surface", () => {
  it("exposes every tool the compatibility doc names", () => {
    for (const name of [
      "graphflow_context",
      "graphflow_run",
      "graphflow_report_outcome",
      "graphflow_plan",
      "graphflow_index",
      "graphflow_insight",
      "graphflow_skill_insights",
      "graphflow_diagnose",
      "graphflow_artifact",
      "graphflow_skill_guide",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it("graphflow_context accepts the exact arguments fetchGraphFlowContext sends", () => {
    const schema = byName.get("graphflow_context")!.inputSchema;
    const props = schema.properties as Record<string, { type?: string }>;
    expect(props.query?.type).toBe("string");
    expect(props.rootDir?.type).toBe("string");
    expect(props.recordDialogue?.type).toBe("boolean");
    expect(props.englishQuery?.type).toBe("string");
    // Additional required args would break the agent's {query, rootDir, recordDialogue} call.
    for (const required of schema.required ?? []) {
      expect(["query", "rootDir", "recordDialogue"]).toContain(required);
    }
  });

  it("graphflow_run / graphflow_report_outcome keep their bridge-mode arguments", () => {
    const run = byName.get("graphflow_run")!.inputSchema;
    expect(run.required).toEqual(["task"]);
    expect((run.properties as Record<string, { type?: string }>).task?.type).toBe("string");
    const outcome = byName.get("graphflow_report_outcome")!.inputSchema;
    expect(outcome.required).toEqual(["episodeId", "success"]);
    const props = outcome.properties as Record<string, { type?: string }>;
    expect(props.episodeId?.type).toBe("string");
    expect(props.success?.type).toBe("boolean");
    expect(props.lessons?.type).toBe("array");
  });

  it("declares governance annotations in this package's risk + capability vocabulary (§21)", () => {
    const policies = fileURLToPath(new URL("../policies/", import.meta.url));
    const riskIds = (
      JSON.parse(readFileSync(join(policies, "risk-classes-v1.json"), "utf8")) as { classes: Array<{ id: string }> }
    ).classes.map((c) => c.id);
    const capabilityIds = (
      JSON.parse(readFileSync(join(policies, "capabilities-v1.json"), "utf8")) as { capabilities: Array<{ id: string }> }
    ).capabilities.map((c) => c.id);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      const meta = tool._meta!;
      expect(riskIds, tool.name).toContain(meta["graphflow/risk"]);
      if (meta["graphflow/conditionalRisk"]) expect(riskIds, tool.name).toContain(meta["graphflow/conditionalRisk"]);
      for (const cap of [...meta["graphflow/capabilities"], ...(meta["graphflow/conditionalCapabilities"] ?? [])]) {
        expect(capabilityIds, `${tool.name}:${cap}`).toContain(cap);
      }
    }
    // The agent calls graphflow_context with recordDialogue:false precisely because it is not read-only.
    expect(byName.get("graphflow_context")!.annotations!.readOnlyHint).toBe(false);
  });
});

describe("S2 graphflow_context response parsing (agent side)", () => {
  it("maps file/symbol/module anchor ids to repo-relative files", () => {
    expect(
      anchorFilesFromIds([
        "file:src/core/efficiency-advisory.ts",
        "symbol:src/surfaces/mcp/server.ts:abc123",
        "module:src/config/paths",
        "dialogue-turn:xyz",
      ])
    ).toEqual(["src/core/efficiency-advisory.ts", "src/surfaces/mcp/server.ts", "src/config/paths.ts"]);
  });
});

describe("S3 graphflow_run advisory = Execution Contract v1 subset", () => {
  it("a minimal substrate advisory passes assertAdvisoryCompatible", () => {
    const advisory = buildEfficiencyAdvisory({
      task: "fix login",
      taskComplexity: "simple",
      executionMode: "bridge",
      durationMs: 0,
    });
    expect(assertAdvisoryCompatible(advisory)).toEqual([]);
  });

  it("a fully populated advisory (as routing.ts builds it) stays compatible", () => {
    const advisory = buildEfficiencyAdvisory({
      task: "Fix axis homing and validate the build",
      taskComplexity: "complex",
      executionMode: "bridge",
      fusedSteps: [
        { id: "s1", action: "edit", target: "src/motion.ts", command: "npm run typecheck" },
        { id: "s2", action: "validate", command: "npm run build" },
      ],
      similarEpisodes: [{ id: "ep1", task: "fix axis homing", score: 1, similarity: 0.8 }],
      requiredAnchors: extractInlinedAnchorIds("[anchor symbol:src/motion.ts:abc123] ..."),
      maxContextTokens: 1600,
      contextCacheHit: false,
      project: { root: "/repo", gitHead: "0".repeat(40) },
      projectValidation: ["npm run typecheck"],
      durationMs: 4,
    });
    expect(assertAdvisoryCompatible(advisory)).toEqual([]);
    expect(advisory.context.requiredAnchors).toEqual(["symbol:src/motion.ts:abc123"]);
    expect(advisory.validation.length).toBeGreaterThan(0);
    // The learned-policy override routing.ts applies must keep the contract valid.
    const withPolicy = {
      ...advisory,
      worker: { ...advisory.worker, modelTier: "economy" as const, executionMode: "one-shot" as const, maxRounds: 1 },
      policyApplied: { version: 3 },
    };
    expect(assertAdvisoryCompatible(withPolicy)).toEqual([]);
  });
});

describe("S4 decision ledger → efficiency-policy.json closed loop", () => {
  it("substrate ledger records feed the package learner, and its output loads back", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, "graphflow-out"), { recursive: true });
    const ledgerPath = join(root, "graphflow-out", "decision-ledger.jsonl");
    const lines = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({
        kind: "decision",
        at: new Date(0).toISOString(),
        taskId: `task:${i}`,
        taskCategory: "simple",
        tool: "graphflow_run",
        mode: "shadow",
        reuseMode: "FRESH",
        modelTier: "standard",
        durationMs: 3,
        llmCalls: 0,
        tokenCost: 0,
        provenance: "deterministic",
      })
    );
    writeFileSync(ledgerPath, `${lines.join("\n")}\n`, "utf8");

    const records = readDecisionLedger(ledgerPath);
    expect(records).toHaveLength(8);
    expect(trajectoryFromLedger(records)).toHaveLength(8);

    const update = learnPolicyFromLedger(records, undefined, { minSamples: 1 });
    const policy = update ?? {
      version: 1,
      minSamples: 1,
      modelTierByCategory: { simple: "economy" as const },
      executionModeByCategory: { simple: "one-shot" as const },
      avoidPatterns: [],
      rationale: ["fixture"],
    };
    writeFileSync(join(root, "graphflow-out", "efficiency-policy.json"), JSON.stringify(policy), "utf8");
    const config = { graphPolicy: { workspaceRoot: root } } as unknown as GraphFlowConfig;
    const loaded = loadEfficiencyPolicy(config);
    expect(loaded?.version).toBe(policy.version);
    expect(loaded?.modelTierByCategory).toEqual(policy.modelTierByCategory);
    expect(loaded?.executionModeByCategory).toEqual(policy.executionModeByCategory);
  });
});

describe("S5 graph artifact identity (public file metadata only)", () => {
  it("derives graphVersion from graphflow-out/graphflow-graph.json size + mtime", () => {
    const root = tempWorkspace();
    expect(graphArtifactVersion(root)).toBeUndefined();
    mkdirSync(join(root, "graphflow-out"), { recursive: true });
    writeFileSync(join(root, "graphflow-out", "graphflow-graph.json"), "{}", "utf8");
    expect(graphArtifactVersion(root)).toMatch(/^graphflow-graph\.json:2:\d+$/);
  });
});
