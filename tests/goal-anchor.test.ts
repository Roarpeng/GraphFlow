import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { submitAgentInsight } from "../src/core/submit-agent-insight";
import { mergeAgentInsightsFromGraph } from "../src/core/merge-agent-insight";
import {
  buildAlignmentCheckWorkItem,
  buildClarificationWorkItem,
} from "../src/core/agent-delegation";
import {
  getActiveGoalAnchor,
  goalNodeIdForTask,
  CLARIFICATION_CONFIDENCE_THRESHOLD,
} from "../src/core/goal-anchor";
import { maybeBuildGoalAnchors } from "../src/core/orchestrator-context";
import { formatPromptWithContext } from "../src/routing/provider-executor";
import {
  DEVIATION_KINDS,
  isDeviationKind,
  recordEpisode,
  updateEpisodeOutcome,
} from "../src/learning/episodic-memory";

const TASK = "add caching to the search endpoint";

const INTENT_V1 = JSON.stringify({
  explicitIntent: "Add caching to search",
  implicitIntent: "Reduce repeated query latency",
  coreProblem: "Search endpoint re-computes identical queries",
  nonGoals: ["changing the ranking algorithm", "database migration"],
  successDefinition: "Repeated identical queries served from cache",
  confidence: 0.9,
});

describe("P0 — goal anchor nodes", () => {
  it("creates an active goal node from an intent submission", async () => {
    const client = new GraphifyClient();
    const result = await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: INTENT_V1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.goal).toBeDefined();
    expect(result.goal?.version).toBe(1);
    expect(result.goal?.versioned).toBe(false);

    const goal = await getActiveGoalAnchor(client, TASK);
    expect(goal).toBeDefined();
    expect(goal?.coreProblem).toContain("re-computes");
    expect(goal?.nonGoals).toContain("changing the ranking algorithm");
    expect(goal?.status).toBe("active");
  });

  it("formats the anchor for prompt and injects it via prompt context", async () => {
    const client = new GraphifyClient();
    await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: INTENT_V1,
    });

    const anchors = await maybeBuildGoalAnchors(TASK, { graphClient: client });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toContain("GOAL(v1):");
    expect(anchors[0]).toContain("DONE WHEN:");
    expect(anchors[0]).toContain("DO NOT: changing the ranking algorithm");

    const rendered = formatPromptWithContext("worker", "do the thing", {
      goalAnchors: anchors,
    });
    expect(rendered).toContain("Goal anchor (original requirement");
    expect(rendered.indexOf("Goal anchor")).toBeLessThan(rendered.indexOf("Task:"));
  });

  it("returns no anchor for tasks without an intent submission", async () => {
    const client = new GraphifyClient();
    const anchors = await maybeBuildGoalAnchors("never analyzed task", { graphClient: client });
    expect(anchors).toEqual([]);
  });
});

describe("P4 — goal versioning + diff", () => {
  it("versions the anchor when the requirement materially changes and stales pending episodes", async () => {
    const client = new GraphifyClient();
    await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: INTENT_V1,
    });

    // A pending episode exists for the old goal.
    const episode = await recordEpisode(client, {
      task: TASK,
      plan: [],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 0,
    });

    const INTENT_V2 = JSON.stringify({
      explicitIntent: "Add caching to search",
      implicitIntent: "Reduce repeated query latency",
      coreProblem: "Search endpoint latency under burst load", // changed
      nonGoals: ["changing the ranking algorithm"],
      successDefinition: "p95 latency below 100ms under burst", // changed
      confidence: 0.85,
    });
    const result = await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: INTENT_V2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.goal?.version).toBe(2);
    expect(result.goal?.versioned).toBe(true);
    expect(result.goal?.changedFields).toContain("coreProblem");
    expect(result.goal?.changedFields).toContain("successDefinition");
    expect(result.goal?.changedFields).not.toContain("explicitIntent");
    expect(result.goal?.staleEpisodes).toBe(1);

    // Superseded snapshot exists with a pointer to the active node.
    const snapshotId = `${goalNodeIdForTask(TASK)}:v1`;
    const nodes = await client.getNodesByIds([snapshotId]);
    const snapshot = nodes.find((n) => n.id === snapshotId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.metadata?.status).toBe("superseded");

    // Active node reflects v2; pending episode flagged staleGoal.
    const active = await getActiveGoalAnchor(client, TASK);
    expect(active?.version).toBe(2);
    const epNodes = await client.getNodesByIds([episode.id]);
    expect(epNodes[0]?.metadata?.staleGoal).toBe(goalNodeIdForTask(TASK));
  });

  it("does not version when the requirement is unchanged", async () => {
    const client = new GraphifyClient();
    await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: INTENT_V1,
    });
    const again = await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: INTENT_V1,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.goal?.version).toBe(1);
    expect(again.goal?.versioned).toBe(false);
  });
});

describe("P3 — low-confidence clarification gate", () => {
  it("blocks merge completion until a confident clarification is submitted", async () => {
    const client = new GraphifyClient();
    const weakIntent = JSON.stringify({
      ...JSON.parse(INTENT_V1),
      confidence: CLARIFICATION_CONFIDENCE_THRESHOLD - 0.2,
    });
    const intentResult = await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: weakIntent,
    });
    expect(intentResult.ok).toBe(true);
    if (!intentResult.ok) return;
    expect(intentResult.needsClarification).toBe(true);

    await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-decomposition",
      response: JSON.stringify([{ id: "t1", description: "implement cache", dependencies: [] }]),
    });

    // All required items in, but confidence still below threshold → no plan.
    const blocked = await mergeAgentInsightsFromGraph(client, TASK);
    expect(blocked.submittedCount).toBe(2);
    expect(blocked.complete).toBe(false);
    expect(blocked.needsClarification).toBe(true);
    expect(blocked.intentConfidence).toBeCloseTo(CLARIFICATION_CONFIDENCE_THRESHOLD - 0.2);

    // Clarification round resolves the ambiguity → merge completes.
    const clarification = JSON.stringify({
      ...JSON.parse(INTENT_V1),
      confidence: 0.9,
      whatChanged: "Confirmed cache scope excludes ranking changes",
    });
    const clarificationResult = await submitAgentInsight(client, {
      task: TASK,
      workItemId: "clarification",
      response: clarification,
    });
    expect(clarificationResult.ok).toBe(true);
    if (!clarificationResult.ok) return;
    expect(clarificationResult.needsClarification).toBeUndefined();
    expect(clarificationResult.goal?.confidence).toBe(0.9);

    const merged = await mergeAgentInsightsFromGraph(client, TASK);
    expect(merged.complete).toBe(true);
    expect(merged.needsClarification).toBe(false);
    expect(merged.plan.length).toBeGreaterThan(0);
  });

  it("legacy payloads without confidence flow through unblocked", async () => {
    const client = new GraphifyClient();
    const legacy = JSON.parse(INTENT_V1) as Record<string, unknown>;
    delete legacy.confidence;
    await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-intent",
      response: JSON.stringify(legacy),
    });
    await submitAgentInsight(client, {
      task: TASK,
      workItemId: "simple-plan-decomposition",
      response: JSON.stringify([{ id: "t1", description: "implement cache", dependencies: [] }]),
    });
    const merged = await mergeAgentInsightsFromGraph(client, TASK);
    expect(merged.complete).toBe(true);
  });
});

describe("P2 — alignment-check protocol", () => {
  it("defines the work item with the drift schema", () => {
    const item = buildAlignmentCheckWorkItem(TASK);
    expect(item.id).toBe("alignment-check");
    expect(item.kind).toBe("alignment");
    expect(item.optional).toBe(true);
    expect(item.prompt).toContain("successDefinition");
    expect(item.prompt).toContain("nonGoals");
    expect(item.responseSchema?.drift).toContain("scope-creep");
  });

  it("accepts alignment-check submissions without blocking merge", async () => {
    const client = new GraphifyClient();
    const result = await submitAgentInsight(client, {
      task: TASK,
      workItemId: "alignment-check",
      response: JSON.stringify({
        aligned: true,
        servedSuccessCriteria: ["cache hit on repeated queries"],
        violatedNonGoals: [],
        drift: "none",
        correction: "",
      }),
    });
    expect(result.ok).toBe(true);
    const merged = await mergeAgentInsightsFromGraph(client, TASK);
    expect(merged.needsClarification).toBe(false);
  });

  it("defines the clarification work item", () => {
    const item = buildClarificationWorkItem(TASK, ["unclear whether ranking is in scope"]);
    expect(item.id).toBe("clarification");
    expect(item.prompt).toContain("unclear whether ranking is in scope");
    expect(item.responseSchema?.whatChanged).toBeDefined();
  });
});

describe("P1 — deviation classification", () => {
  it("persists deviation on the episode record", async () => {
    const client = new GraphifyClient();
    const episode = await recordEpisode(client, {
      task: TASK,
      plan: [],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });
    const updated = await updateEpisodeOutcome(
      client,
      episode.id,
      "fail",
      ["scope grew mid-task"],
      "scope-creep"
    );
    expect(updated?.deviation).toBe("scope-creep");

    // Round-trip through the graph node record.
    const nodes = await client.getNodesByIds([episode.id]);
    const raw = nodes[0]?.metadata?.record;
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    expect(parsed.deviation).toBe("scope-creep");
  });

  it("validates deviation kinds", () => {
    for (const kind of DEVIATION_KINDS) {
      expect(isDeviationKind(kind)).toBe(true);
    }
    expect(isDeviationKind("random")).toBe(false);
    expect(isDeviationKind(undefined)).toBe(false);
  });
});
