import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../src/config/resolve";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import { recordEpisode, type EpisodeRecord } from "../src/learning/episodic-memory";
import {
  forgetEpisode,
  listEpisodes,
  searchEpisodes,
} from "../src/surfaces/cli/runtime";

/**
 * M-memory: CLI memory audit surface — `graphflow memory list|search|forget`.
 * Episodes live in the graph store, so the tests use an isolated FILE transport
 * (not memory): each runtime call creates its own client, and only a persistent
 * store proves cross-call list/forget semantics.
 */
describe("M-memory CLI audit", () => {
  interface Sandbox {
    configPath: string;
    cleanup(): void;
  }

  function makeSandbox(): Sandbox {
    const dir = mkdtempSync(join(tmpdir(), "graphflow-memory-"));
    const configPath = join(dir, "graphflow.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          providers: {},
          tiers: {
            smart: { provider: "openai", model: "gpt-4.1" },
            economy: { provider: "openai", model: "gpt-4.1-mini" },
          },
          budgetPolicy: { runTokenCap: 2000 },
          learningPolicy: {
            enableFlywheel: true,
            trainingCadence: "nightly",
            exportPath: join(dir, "learning.jsonl"),
          },
          // No transformers downloads in tests: FNV/Jaccard fallback is the
          // documented memory-search degradation path.
          embeddingPolicy: { enabled: false },
          graphPolicy: {
            transport: "file",
            graphStorePath: join(dir, "graph-store.json"),
            autoIndexOnRun: false,
            autoIndexOnPreview: false,
            autoIndexOnSave: false,
          },
        },
        null,
        2
      ),
      "utf8"
    );
    return { configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  function makeClient(configPath: string): GraphClient {
    return createGraphClient(resolveConfig(configPath));
  }

  async function record(
    configPath: string,
    input: { task: string; outcome: EpisodeRecord["outcome"]; lessons?: string[] }
  ): Promise<EpisodeRecord> {
    return recordEpisode(makeClient(configPath), {
      task: input.task,
      plan: [],
      outcome: input.outcome,
      keyDecisions: [],
      lessons: input.lessons ?? [],
      attempts: 1,
    });
  }

  it("lists episodes as evidence records sorted by updatedAt desc, with outcome/limit filters", async () => {
    const sandbox = makeSandbox();
    try {
      // Seed with explicit timestamps so the sort order is fully deterministic
      // (recordEpisode stamps Date.now(), which can tie across recordings).
      const client = makeClient(sandbox.configPath);
      const seed = async (
        id: string,
        input: { task: string; outcome: EpisodeRecord["outcome"]; lessons?: string[]; updatedAt: number }
      ): Promise<void> => {
        await client.upsertNodes([
          {
            id,
            type: "Decision",
            content: `episode ${input.task}`,
            metadata: {
              kind: "episode",
              record: JSON.stringify({
                id,
                task: input.task,
                plan: [],
                outcome: input.outcome,
                keyDecisions: [],
                lessons: input.lessons ?? [],
                attempts: 1,
                createdAt: input.updatedAt,
                updatedAt: input.updatedAt,
              }),
            },
          },
        ]);
      };
      await seed("episode:pass-one", {
        task: "refactor orchestrator and add tests",
        outcome: "pass",
        lessons: ["bridge outcomes back to the episode"],
        updatedAt: 1000,
      });
      await seed("episode:fail-one", {
        task: "update readme documentation",
        outcome: "fail",
        updatedAt: 2000,
      });
      await seed("episode:pending-one", {
        task: "wire sqlite backend into file indexer",
        outcome: "pending",
        updatedAt: 3000,
      });

      const items = await listEpisodes(sandbox.configPath);
      expect(items.map((item) => item.id)).toEqual([
        "episode:pending-one",
        "episode:fail-one",
        "episode:pass-one",
      ]);
      expect(items[0]).toMatchObject({ outcome: "pending", updatedAt: 3000 });
      expect(items[2]).toMatchObject({ outcome: "pass", lessons: 1, updatedAt: 1000 });
      expect(items[1]?.lessons).toBe(0);

      const onlyFails = await listEpisodes(sandbox.configPath, { outcome: "fail" });
      expect(onlyFails.map((item) => item.id)).toEqual(["episode:fail-one"]);

      const onlyPasses = await listEpisodes(sandbox.configPath, { outcome: "pass" });
      expect(onlyPasses.map((item) => item.id)).toEqual(["episode:pass-one"]);

      const limited = await listEpisodes(sandbox.configPath, { limit: 2 });
      expect(limited.map((item) => item.id)).toEqual([
        "episode:pending-one",
        "episode:fail-one",
      ]);
    } finally {
      sandbox.cleanup();
    }
  });

  it("surfaces the staleGoal flag when a pending episode was invalidated by a new goal", async () => {
    const sandbox = makeSandbox();
    try {
      const client = makeClient(sandbox.configPath);
      const staleId = "episode:stale-goal-evidence";
      await client.upsertNodes([
        {
          id: staleId,
          type: "Decision",
          content: "episode stale goal evidence",
          metadata: {
            kind: "episode",
            staleGoal: "goal:new-requirement",
            record: JSON.stringify({
              id: staleId,
              task: "stale goal evidence task",
              plan: [],
              outcome: "pending",
              keyDecisions: [],
              lessons: [],
              attempts: 1,
              createdAt: 1000,
              updatedAt: 2000,
            }),
          },
        },
      ]);

      const items = await listEpisodes(sandbox.configPath);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: staleId,
        outcome: "pending",
        staleGoal: "goal:new-requirement",
        task: "stale goal evidence task",
      });
    } finally {
      sandbox.cleanup();
    }
  });

  it("searches episodes with ranked hits carrying similarity scores and outcomes", async () => {
    const sandbox = makeSandbox();
    try {
      const best = await record(sandbox.configPath, {
        task: "refactor orchestrator and add tests",
        outcome: "pass",
      });
      const mid = await record(sandbox.configPath, {
        task: "refactor orchestrator module for clarity",
        outcome: "pending",
      });
      await record(sandbox.configPath, {
        task: "update readme documentation",
        outcome: "fail",
      });

      const hits = await searchEpisodes("refactor orchestrator tests", sandbox.configPath, 3);

      expect(hits.length).toBeGreaterThanOrEqual(2);
      const ids = hits.map((hit) => hit.id);
      expect(ids).toContain(best.id);
      expect(ids).toContain(mid.id);

      const bestHit = hits.find((hit) => hit.id === best.id);
      const midHit = hits.find((hit) => hit.id === mid.id);
      expect(bestHit).toBeDefined();
      expect(midHit).toBeDefined();
      expect(bestHit!.score).toBeGreaterThan(midHit!.score);
      expect(bestHit!.score).toBeGreaterThan(0);
      expect(midHit!.score).toBeGreaterThan(0);
      expect(bestHit!.outcome).toBe("pass");

      // Highest-ranked hit is the closest lexical match.
      expect(hits[0]?.id).toBe(best.id);
      // Scores are normalized token-overlap evidence in [0, 1].
      for (const hit of hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
        expect(["pass", "fail", "pending"]).toContain(hit.outcome);
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it("forgets a single episode and re-list confirms it is gone", async () => {
    const sandbox = makeSandbox();
    try {
      const pass = await record(sandbox.configPath, {
        task: "refactor orchestrator and add tests",
        outcome: "pass",
      });
      await record(sandbox.configPath, {
        task: "update readme documentation",
        outcome: "fail",
      });

      const before = await listEpisodes(sandbox.configPath);
      expect(before).toHaveLength(2);

      const result = await forgetEpisode(pass.id, sandbox.configPath);
      expect(result).toEqual({ found: true, removed: true });

      const after = await listEpisodes(sandbox.configPath);
      expect(after).toHaveLength(1);
      expect(after[0]?.id).not.toBe(pass.id);

      // Forgotten episodes also drop out of semantic search.
      const hits = await searchEpisodes("refactor orchestrator", sandbox.configPath, 5);
      expect(hits.map((hit) => hit.id)).not.toContain(pass.id);
    } finally {
      sandbox.cleanup();
    }
  });

  it("forget with an unknown id is a clean no-op that reports not-found", async () => {
    const sandbox = makeSandbox();
    try {
      await record(sandbox.configPath, {
        task: "refactor orchestrator and add tests",
        outcome: "pass",
      });

      const result = await forgetEpisode("episode:does-not-exist", sandbox.configPath);
      expect(result).toEqual({ found: false, removed: false, reason: "not-found" });

      // Store untouched: nothing was removed and the remaining episode is intact.
      const items = await listEpisodes(sandbox.configPath);
      expect(items).toHaveLength(1);
      expect(items[0]?.outcome).toBe("pass");
    } finally {
      sandbox.cleanup();
    }
  });
});
