import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { buildAgentInsightWorkItems } from "../src/core/agent-delegation";
import {
  loadAgentInsightRecords,
  mergeAgentInsights,
  mergeAgentInsightsFromGraph,
} from "../src/core/merge-agent-insight";
import { submitAgentInsight } from "../src/core/submit-agent-insight";
import { GraphifyClient } from "../src/graph/graphify-client";
import { createMcpServer, executeToolCall } from "../src/surfaces/mcp/server";

function hatResponse(observation: string, criticalInsight: string) {
  return JSON.stringify({
    observation,
    certainty: 0.7,
    criticalInsight,
  });
}

function writeFileConfig(storePath: string): string {
  const config = getDefaultConfig();
  const path = join(tmpdir(), `graphflow-m59-${Date.now()}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      providers: {},
      graphPolicy: {
        ...config.graphPolicy,
        transport: "file",
        graphStorePath: storePath,
      },
    }),
    "utf8"
  );
  return path;
}

describe("M59 merge agent insight", () => {
  const task = "refactor planner module and add tests";

  it("submit 6 hats + plan-refinement yields complete merge with plan", async () => {
    const client = new GraphifyClient();
    const workItems = buildAgentInsightWorkItems(task);

    let lastResult: Awaited<ReturnType<typeof submitAgentInsight>> | undefined;
    for (const item of workItems) {
      if (item.id === "plan-refinement") {
        lastResult = await submitAgentInsight(client, {
          task,
          workItemId: item.id,
          response: JSON.stringify([
            { id: "task-1", description: "Analyze planner module", dependencies: [] },
            { id: "task-2", description: "Add regression tests", dependencies: ["task-1"] },
          ]),
        });
        continue;
      }

      lastResult = await submitAgentInsight(client, {
        task,
        workItemId: item.id,
        hat: item.hat,
        response: hatResponse(`${item.hat} observation`, `${item.hat} insight`),
      });
    }

    expect(lastResult?.ok).toBe(true);
    if (lastResult?.ok) {
      expect(lastResult.merge?.complete).toBe(true);
      expect(lastResult.merge?.plan.length).toBeGreaterThan(0);
    }

    const merged = await mergeAgentInsightsFromGraph(client, task);
    expect(merged.complete).toBe(true);
    expect(merged.missing).toEqual([]);
    expect(merged.submittedCount).toBe(11);
    expect(merged.insight.hats.length).toBe(6);
    expect(merged.plan.length).toBeGreaterThan(0);
  });

  it("five-whys submission populates root causes and refined statement", async () => {
    const client = new GraphifyClient();
    const whyTask = "diagnose flaky checkout pipeline and stabilize";
    const workItems = buildAgentInsightWorkItems(whyTask);

    for (const item of workItems) {
      if (item.kind === "five-whys") {
        continue;
      }
      if (item.id === "plan-refinement") {
        await submitAgentInsight(client, {
          task: whyTask,
          workItemId: item.id,
          response: JSON.stringify([
            { id: "task-1", description: "Reproduce flaky failure", dependencies: [] },
          ]),
        });
        continue;
      }
      const certainty = item.id === "hat-3-black" ? 0.4 : 0.7;
      await submitAgentInsight(client, {
        task: whyTask,
        workItemId: item.id,
        hat: item.hat,
        response: JSON.stringify({
          observation: `${item.hat} observation`,
          certainty,
          criticalInsight: `${item.hat} insight`,
        }),
      });
    }

    await submitAgentInsight(client, {
      task: whyTask,
      workItemId: "why-3-black",
      hat: "Black Hat",
      response: JSON.stringify({
        steps: [
          { question: "Why?", answer: "because X" },
          { question: "Why X?", answer: "root Y" },
        ],
        rootCause: "root Y",
      }),
    });

    const merged = await mergeAgentInsightsFromGraph(client, whyTask);
    expect(merged.complete).toBe(true);
    expect(merged.insight.rootCauses).toContain("root Y");
    const blackHat = merged.insight.hats.find((h) => h.hat.color === "black");
    expect(blackHat?.whyChain).not.toBeNull();
    expect(blackHat?.whyChain?.rootCause).toBe("root Y");
    expect(merged.insight.refinedTaskStatement).toContain("root Y");
    expect(merged.insight.refinedTaskStatement).not.toContain("待探索");
  });

  it("partial submit is incomplete with missing work items listed", async () => {
    const client = new GraphifyClient();

    await submitAgentInsight(client, {
      task,
      workItemId: "hat-1-white",
      hat: "White Hat",
      response: hatResponse("facts gathered", "need more data"),
    });
    await submitAgentInsight(client, {
      task,
      workItemId: "hat-2-red",
      hat: "Red Hat",
      response: hatResponse("gut feeling positive", "team morale matters"),
    });

    const records = await loadAgentInsightRecords(client, task);
    const merged = mergeAgentInsights(task, records);

    expect(merged.complete).toBe(false);
    expect(merged.missing).toContain("hat-3-black");
    expect(merged.missing).toContain("plan-refinement");
    expect(merged.submittedCount).toBe(2);
  });

  it("MCP graphflow_merge_insight works", async () => {
    const storePath = join(tmpdir(), `graphflow-m59-store-${Date.now()}.json`);
    const configPath = writeFileConfig(storePath);

    try {
      await executeToolCall(
        {
          name: "graphflow_submit_insight",
          arguments: {
            task: "merge via mcp",
            workItemId: "hat-1-white",
            response: hatResponse("context available", "index is fresh"),
            configPath,
          },
        },
        createMcpServer()
      );

      const response = await executeToolCall(
        {
          name: "graphflow_merge_insight",
          arguments: {
            task: "merge via mcp",
            configPath,
          },
        },
        createMcpServer()
      );

      const text = response.content[0]?.text;
      expect(text).toBeDefined();
      const result = JSON.parse(text!) as {
        complete: boolean;
        missing: string[];
        submittedCount: number;
        plan: unknown[];
      };
      expect(result.complete).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.submittedCount).toBe(1);
      expect(Array.isArray(result.plan)).toBe(true);
    } finally {
      unlinkSync(configPath);
      try {
        unlinkSync(storePath);
      } catch {
        // ignore missing store file
      }
    }
  });
});
