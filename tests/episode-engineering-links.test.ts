import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { linkEpisodeToEngineeringNodes } from "../src/graph/episode-engineering-links";
import type { GraphNode } from "../src/core/types";

describe("linkEpisodeToEngineeringNodes", () => {
  it("creates derived_from edges from episode to requirement (and concept)", async () => {
    const client = new GraphifyClient();
    const episodeId = "episode:fake-fail-1";
    const requirementId = "requirement:must-cache-tokenizer";
    const conceptId = "concept:tokenizer-cache";

    const nodes: GraphNode[] = [
      {
        id: episodeId,
        type: "Decision",
        content: "episode failed tokenizer cache",
        metadata: { kind: "episode" },
      },
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
        id: "file:src/tokenizer.ts",
        type: "File",
        content: "tokenizer.ts",
      },
    ];
    await client.upsertNodes(nodes);

    const result = await linkEpisodeToEngineeringNodes(client, episodeId, {
      requirementIds: [requirementId],
      conceptIds: [conceptId],
      codeHints: ["src/tokenizer.ts"],
    });

    expect(result.edgeCount).toBe(3);
    expect(result.linkedRequirementIds).toEqual([requirementId]);
    expect(result.linkedConceptIds).toEqual([conceptId]);
    expect(result.linkedCodeNodeIds).toEqual(["file:src/tokenizer.ts"]);

    const snap = client.readSnapshot();
    const derived = snap.edges.filter(
      (e) => e.from === episodeId && e.relation === "derived_from"
    );
    expect(derived).toEqual(
      expect.arrayContaining([
        { from: episodeId, to: requirementId, relation: "derived_from" },
        { from: episodeId, to: conceptId, relation: "derived_from" },
        { from: episodeId, to: "file:src/tokenizer.ts", relation: "derived_from" },
      ])
    );
  });

  it("is a no-op when hints are empty", async () => {
    const client = new GraphifyClient();
    const result = await linkEpisodeToEngineeringNodes(client, "episode:x", {});
    expect(result.edgeCount).toBe(0);
    expect(client.readSnapshot().edges).toEqual([]);
  });
});
