import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/routing/provider-executor", async () => {
  const actual = await vi.importActual<typeof import("../src/routing/provider-executor")>(
    "../src/routing/provider-executor"
  );
  return {
    ...actual,
    executeRolePrompt: vi.fn(),
  };
});

import { validateConfig } from "../src/config/loader";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  findSimilarEpisodes,
  loadAllEpisodes,
  recordEpisode,
  summarizeEpisodeForPrompt,
} from "../src/learning/episodic-memory";
import { reflectOnEpisodes } from "../src/learning/reflector";
import { orchestrate } from "../src/core/orchestrator";
import {
  executeRolePrompt,
  type PromptContext,
} from "../src/routing/provider-executor";

const mockedExec = vi.mocked(executeRolePrompt);

function makeClient(): GraphClient {
  const config = validateConfig({
    providers: {},
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
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  });
  return createGraphClient(config);
}

describe("M26 episodic memory", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("A: recordEpisode persists an Episode node retrievable via findSimilarEpisodes", async () => {
    const client = makeClient();
    const episode = await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [{ id: "t1", description: "split planner" }],
      outcome: "pass",
      keyDecisions: ["split into 3 subtasks", "preserve public api"],
      lessons: [],
      attempts: 1,
    });

    expect(episode.id.startsWith("episode:")).toBe(true);
    expect(episode.task).toContain("refactor planner");

    const matches = await findSimilarEpisodes(client, "refactor planner module and add tests", 5);
    const found = matches.find((m) => m.id === episode.id);
    expect(found).toBeDefined();
    expect(found?.keyDecisions).toEqual(["split into 3 subtasks", "preserve public api"]);
    expect(found?.outcome).toBe("pass");

    const summary = summarizeEpisodeForPrompt(episode);
    expect(summary).toContain("Past episode");
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it("B: findSimilarEpisodes ranks pass episodes higher than fail for same tokens", async () => {
    const client = makeClient();
    const fail = await recordEpisode(client, {
      task: "refactor planner module",
      plan: [],
      outcome: "fail",
      keyDecisions: ["tried direct rewrite"],
      lessons: [],
      attempts: 2,
    });
    const pass = await recordEpisode(client, {
      task: "refactor planner module",
      plan: [],
      outcome: "pass",
      keyDecisions: ["split into subtasks"],
      lessons: [],
      attempts: 1,
    });

    const ranked = await findSimilarEpisodes(client, "refactor planner module", 5);
    const passIdx = ranked.findIndex((r) => r.id === pass.id);
    const failIdx = ranked.findIndex((r) => r.id === fail.id);
    expect(passIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(passIdx).toBeLessThan(failIdx);
  });

  it("C: reflectOnEpisodes synthesizes Lesson nodes with improves edges", async () => {
    const client = makeClient();
    const ep1 = await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["split into subtasks", "write fixtures first"],
      lessons: [],
      attempts: 1,
    });
    const ep2 = await recordEpisode(client, {
      task: "refactor planner orchestrator and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["split into subtasks", "mock provider executor"],
      lessons: [],
      attempts: 1,
    });

    const lessons = await reflectOnEpisodes(client);
    expect(lessons.length).toBeGreaterThan(0);
    const topLesson = lessons.find((l) => l.lesson === "split into subtasks");
    expect(topLesson).toBeDefined();
    expect(topLesson?.episodeIds.sort()).toEqual([ep1.id, ep2.id].sort());
    expect(topLesson?.outcomes.pass).toBe(2);

    const persisted = await client.queryByKeyword("lesson");
    expect(persisted.some((n) => n.id === topLesson!.id && n.id.startsWith("lesson:"))).toBe(true);

    const neighbors = await client.getNeighbors!(
      [topLesson!.id],
      ["improves"],
      "out"
    );
    const neighborIds = new Set(neighbors.map((n) => n.node.id));
    expect(neighborIds.has(ep1.id)).toBe(true);
    expect(neighborIds.has(ep2.id)).toBe(true);
  });

  it("D: orchestrate with enableEpisodicMemory records and recalls episodes", async () => {
    mockedExec.mockResolvedValue(
      "done refactor planner module and add tests integrate and verify"
    );
    const client = makeClient();
    await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["split into subtasks"],
      lessons: [],
      attempts: 1,
    });
    await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["mock provider"],
      lessons: [],
      attempts: 1,
    });

    const run = await orchestrate(
      { task: "refactor planner module and add tests" },
      {
        graphClient: client,
        enableEpisodicMemory: true,
        enableLlmAgents: false,
      }
    );

    expect(run.episodeId).toBeDefined();
    expect(run.episodeId?.startsWith("episode:")).toBe(true);
    expect(run.similarEpisodes).toBeDefined();
    expect(run.similarEpisodes!.length).toBeGreaterThan(0);

    const all = await loadAllEpisodes(client);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("E: enableGraphContextInPrompt + enableEpisodicMemory injects episode summaries into prompt context", async () => {
    const client = makeClient();
    await recordEpisode(client, {
      task: "refactor orchestrator and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["split into subtasks"],
      lessons: [],
      attempts: 1,
    });

    // Seed graph with searchable symbol content so summaryChannel is non-empty.
    const inner = new GraphifyClient();
    await inner.upsertNodes([
      { id: "file-1", type: "File", content: "src/orchestrator.ts: orchestrator entry" },
      { id: "sym-1", type: "Symbol", content: "function orchestrator runs the DAG" },
    ]);
    const wrappedClient: GraphClient = {
      async upsertNodes(nodes) {
        await client.upsertNodes(nodes);
        await inner.upsertNodes(nodes);
      },
      async upsertEdges(edges) {
        await client.upsertEdges(edges);
        await inner.upsertEdges(edges);
      },
      async queryByKeyword(query) {
        const a = await client.queryByKeyword(query);
        const b = await inner.queryByKeyword(query);
        const map = new Map<string, (typeof a)[number]>();
        for (const n of [...a, ...b]) map.set(n.id, n);
        return Array.from(map.values());
      },
    };

    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
    ]);
    mockedExec.mockImplementation(async (role, prompt) => {
      if (role === "worker") return `worker output for ${prompt}`;
      if (role === "planner") {
        if (prompt.includes("Brainstorm 3 short ideas")) {
          return "目标澄清: 明确目标\n实现路径: 拆分子任务\n风险提示: 注意回归";
        }
        if (prompt.includes("Decompose the task")) return plannerJson;
        return "planner draft text";
      }
      return "";
    });

    const run = await orchestrate(
      { task: "refactor orchestrator and add tests", maxRetries: 1 },
      {
        graphClient: wrappedClient,
        enableEpisodicMemory: true,
        enableLlmAgents: true,
        enableNearLosslessMode: true,
        enableGraphContextInPrompt: true,
        maxContextTokens: 1200,
      }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.episodeId).toBeDefined();

    const withEpisodeInstr = mockedExec.mock.calls.filter((call) => {
      const ctx = call[3] as PromptContext | undefined;
      return ctx?.extraInstructions?.some((line) => line.includes("Past episode"));
    });
    expect(withEpisodeInstr.length).toBeGreaterThan(0);
  });
});
