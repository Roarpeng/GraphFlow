import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";
import {
  buildCliUsage,
  collectCliFlagValues,
  parseCliSuccess,
  readCliFlagValue,
} from "../src/surfaces/cli/output";
import {
  getSkillInsights,
  reportOutcome,
  runTaskResult,
  submitAgentInsightResult,
  mergeAgentInsightResult,
} from "../src/surfaces/cli/runtime";

describe("Bridge CLI learning loop", () => {
  it("documents outcome/insight CLI fallbacks in usage text", () => {
    const usage = buildCliUsage();
    expect(usage).toContain("outcome report <episodeId> <success>");
    expect(usage).toContain("insight submit");
    expect(usage).toContain("insight merge");
  });

  it("parses success tokens and repeated lesson flags", () => {
    expect(parseCliSuccess("true")).toBe(true);
    expect(parseCliSuccess("PASS")).toBe(true);
    expect(parseCliSuccess("false")).toBe(false);
    expect(parseCliSuccess("fail")).toBe(false);
    expect(parseCliSuccess("maybe")).toBeUndefined();

    expect(collectCliFlagValues(["--lesson", "a", "--lesson", "b"], "--lesson")).toEqual([
      "a",
      "b",
    ]);
    expect(readCliFlagValue(["--task", "hello world"], "--task")).toBe("hello world");
    expect(readCliFlagValue(["--task=hello"], "--task")).toBe("hello");
  });

  it("closes bridge flywheel via insight submit/merge + outcome report", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-bridge-cli-"));
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
        skillPolicy: {
          enableSkillFlywheel: true,
          maxSkillHints: 4,
        },
        routingPolicy: {
          enableDynamicRouting: false,
          requireApiKeyForHealthy: true,
        },
      });

      const task = "refactor orchestrator and strengthen bridge outcome reporting";
      const runResult = await runTaskResult(task, configPath);
      expect(runResult.episodeId).toBeTruthy();

      const intent = await submitAgentInsightResult(
        task,
        "intent-analysis",
        JSON.stringify({
          intent: "Close CLI bridge learning loop",
          users: ["coding agents without MCP"],
          successCriteria: ["outcome report updates skills"],
        }),
        configPath,
        runResult.episodeId
      );
      expect(intent.ok).toBe(true);

      const requirement = await submitAgentInsightResult(
        task,
        "requirement-analysis",
        JSON.stringify({
          functional: ["CLI outcome report", "CLI insight submit/merge"],
          constraints: ["no MCP required"],
          acceptance: ["skillsUpdated > 0 after success"],
        }),
        configPath,
        runResult.episodeId
      );
      expect(requirement.ok).toBe(true);

      const merged = await mergeAgentInsightResult(task, configPath);
      expect(merged.submittedCount).toBeGreaterThan(0);
      expect(merged.complete).toBe(false);

      const outcome = await reportOutcome(
        runResult.episodeId!,
        true,
        [
          "prefer CLI outcome report when MCP unavailable in bridge-cli.ts",
          "submit insights before treating bridge plan as final in plan.ts",
        ],
        configPath
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.outcome).toBe("pass");
      expect((outcome.skillsUpdated ?? 0)).toBeGreaterThan(0);

      const insights = await getSkillInsights(configPath, 10);
      expect(insights.skills.length).toBeGreaterThan(0);
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
