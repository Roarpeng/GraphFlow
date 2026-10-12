import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import {
  retrieveSimilarEpisodes,
  taskTextSimilarity,
} from "../src/agents/episode-retrieval";
import type { GraphNode } from "../src/core/types";

/**
 * retrieveSimilarEpisodes: episode/dialogue candidate parsing, ranking and
 * graceful degradation. Node shapes mirror the real writers:
 * - episodes: recordEpisode() → id "episode:<hash>", metadata.record JSON
 *   ({task, outcome, lessons, deviation, ...}), metadata.pruned soft-delete.
 * - dialogue turns: recordDialogueTurn() → id "dialogue:<hash>:<seq>",
 *   metadata.record JSON ({userQuery, assistantReply, invalidAt, ...}).
 */

function episodeNode(
  id: string,
  record: Record<string, unknown>,
  metadata: Record<string, unknown> = {}
): GraphNode {
  return {
    id,
    type: "Decision",
    content: `episode ${String(record.task ?? "")}`,
    metadata: { kind: "episode", record: JSON.stringify({ id, ...record }), ...metadata },
  };
}

function dialogueNode(id: string, record: Record<string, unknown>): GraphNode {
  return {
    id,
    type: "Decision",
    content: `dialogue-turn ${String(record.userQuery ?? "")}`,
    metadata: { kind: "dialogue-turn", record: JSON.stringify({ id, ...record }) },
  };
}

describe("retrieveSimilarEpisodes", () => {
  it("ranks similar episodes above dissimilar ones and exposes record fields", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      episodeNode("episode:aaa", {
        task: "fix crash in sqlite client on windows",
        outcome: "pass",
        lessons: ["close sqlite handles before unlinking the store file"],
        deviation: "none",
      }),
      episodeNode("episode:bbb", {
        task: "fix crash in sqlite store during vacuum",
        outcome: "fail",
        lessons: ["vacuum must run outside a write transaction"],
      }),
      episodeNode("episode:ccc", {
        task: "update readme with install instructions",
        outcome: "pass",
        lessons: [],
      }),
    ]);

    const hits = await retrieveSimilarEpisodes(client, "fix crash in sqlite client");

    expect(hits.length).toBe(3);
    expect(hits[0]?.episodeId).toBe("episode:aaa");
    expect(hits[1]?.episodeId).toBe("episode:bbb");
    // The readme episode scores lowest but still shares a stop-ish token.
    expect(hits[2]?.episodeId).toBe("episode:ccc");
    for (let index = 1; index < hits.length; index += 1) {
      expect(hits[index - 1]?.similarity).toBeGreaterThanOrEqual(hits[index]?.similarity ?? 0);
    }

    const top = hits[0]!;
    expect(top.success).toBe(true);
    expect(top.deviation).toBe("none");
    expect(top.taskPreview).toContain("fix crash in sqlite client on windows");
    expect(top.lessons[0]).toContain("close sqlite handles");
    expect(top.similarity).toBeGreaterThan(0);
    expect(hits[1]?.success).toBe(false);
  });

  it("excludes pending and pruned episodes", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      episodeNode("episode:pending", {
        task: "fix crash in sqlite client on windows",
        outcome: "pending",
        lessons: [],
      }),
      episodeNode("episode:pruned", {
        task: "fix crash in sqlite client on windows",
        outcome: "pass",
        lessons: [],
      }, { pruned: true }),
      episodeNode("episode:valid", {
        task: "fix crash in sqlite client on windows",
        outcome: "pass",
        lessons: [],
      }),
    ]);

    const hits = await retrieveSimilarEpisodes(client, "fix crash in sqlite client");
    expect(hits.map((hit) => hit.episodeId)).toEqual(["episode:valid"]);
  });

  it("excludes superseded and pending dialogue turns, keeps resolved ones", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      dialogueNode("dialogue:s1:1", {
        sessionId: "dialogue-session:s1",
        seq: 1,
        userQuery: "fix crash in sqlite client",
        assistantReply: "the crash came from an unclosed handle in close()",
        summary: "sqlite crash root cause: unclosed handle",
        jumped: false,
        relatedNodeIds: ["symbol:sqlite-client"],
        createdAt: 1,
        updatedAt: 1,
      }),
      dialogueNode("dialogue:s1:2", {
        sessionId: "dialogue-session:s1",
        seq: 2,
        userQuery: "fix crash in sqlite client",
        assistantReply: "",
        jumped: false,
        relatedNodeIds: [],
        createdAt: 2,
        updatedAt: 2,
      }),
      dialogueNode("dialogue:s1:3", {
        sessionId: "dialogue-session:s1",
        seq: 3,
        userQuery: "fix crash in sqlite client",
        assistantReply: "stale conclusion",
        jumped: false,
        relatedNodeIds: [],
        createdAt: 3,
        updatedAt: 3,
        invalidAt: 99,
      }),
      // Session hub nodes are not turns and must never surface as episodes.
      dialogueNode("dialogue-session:s1", { name: "main", turnCount: 3 }),
    ]);

    const hits = await retrieveSimilarEpisodes(client, "fix crash in sqlite client");
    expect(hits.map((hit) => hit.episodeId)).toEqual(["dialogue:s1:1"]);
    expect(hits[0]?.success).toBe(true);
    expect(hits[0]?.relatedSymbols).toEqual(["symbol:sqlite-client"]);
    expect(hits[0]?.lessons[0]).toContain("unclosed handle");
  });

  it("enriches episodes with related symbols via derived_from edges", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      episodeNode("episode:aaa", {
        task: "fix crash in sqlite client",
        outcome: "pass",
        lessons: [],
      }),
      { id: "symbol:sqlite-client", type: "Symbol", content: "sqlite client" },
      { id: "concept:storage", type: "Concept", content: "storage concept" },
    ]);
    await client.upsertEdges([
      { from: "episode:aaa", to: "symbol:sqlite-client", relation: "derived_from" },
      { from: "episode:aaa", to: "concept:storage", relation: "derived_from" },
    ]);

    const hits = await retrieveSimilarEpisodes(client, "fix crash in sqlite client");
    expect(hits[0]?.relatedSymbols).toEqual(["symbol:sqlite-client"]);
  });

  it("breaks similarity ties deterministically by id and respects the limit", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      episodeNode("episode:zzz", { task: "add dark mode toggle", outcome: "pass", lessons: [] }),
      episodeNode("episode:aaa", { task: "add dark mode toggle", outcome: "pass", lessons: [] }),
      episodeNode("episode:mmm", { task: "add dark mode toggle", outcome: "pass", lessons: [] }),
    ]);

    const all = await retrieveSimilarEpisodes(client, "add dark mode toggle");
    expect(all.map((hit) => hit.episodeId)).toEqual(["episode:aaa", "episode:mmm", "episode:zzz"]);
    expect(all[0]?.similarity).toBe(all[2]?.similarity);

    const limited = await retrieveSimilarEpisodes(client, "add dark mode toggle", { limit: 2 });
    expect(limited.map((hit) => hit.episodeId)).toEqual(["episode:aaa", "episode:mmm"]);
  });

  it("matches Chinese tasks against Chinese episode text", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      episodeNode("episode:cjk", {
        task: "修复规划器在中文任务上的崩溃",
        outcome: "pass",
        lessons: ["规划器需要先做任务分句"],
      }),
    ]);

    const hits = await retrieveSimilarEpisodes(client, "修复中文规划器崩溃");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.episodeId).toBe("episode:cjk");
    expect(taskTextSimilarity("修复中文规划器崩溃", "修复规划器在中文任务上的崩溃")).toBeGreaterThan(
      taskTextSimilarity("修复中文规划器崩溃", "update readme install instructions")
    );
  });

  it("returns [] on an empty graph, blank task, malformed records and failing clients", async () => {
    const empty = new GraphifyClient();
    expect(await retrieveSimilarEpisodes(empty, "fix crash in sqlite client")).toEqual([]);

    const seeded = new GraphifyClient();
    await seeded.upsertNodes([
      episodeNode("episode:aaa", { task: "fix crash in sqlite client", outcome: "pass" }),
    ]);
    expect(await retrieveSimilarEpisodes(seeded, "   ")).toEqual([]);

    const malformed = new GraphifyClient();
    await malformed.upsertNodes([
      {
        id: "episode:bad",
        type: "Decision",
        content: "episode broken record",
        metadata: { kind: "episode", record: "{not json" },
      },
    ]);
    // Malformed record falls back to node.content as task text — still no crash.
    const hits = await retrieveSimilarEpisodes(malformed, "broken record");
    expect(Array.isArray(hits)).toBe(true);

    const failing = {
      upsertNodes: async () => undefined,
      upsertEdges: async () => undefined,
      queryByKeyword: async () => {
        throw new Error("store unavailable");
      },
    } satisfies GraphClient;
    expect(await retrieveSimilarEpisodes(failing, "fix crash")).toEqual([]);
  });

  it("falls back to keyword channels when no snapshot is available", async () => {
    const nodes = [
      episodeNode("episode:kw", { task: "fix crash in sqlite client", outcome: "pass", lessons: [] }),
    ];
    const keywordOnly = {
      upsertNodes: async () => undefined,
      upsertEdges: async () => undefined,
      queryByKeyword: async (query: string) => (query === "episode" ? nodes : []),
    } satisfies GraphClient;

    const hits = await retrieveSimilarEpisodes(keywordOnly, "fix crash in sqlite client");
    expect(hits.map((hit) => hit.episodeId)).toEqual(["episode:kw"]);
  });
});
