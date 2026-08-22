import { describe, expect, it } from "vitest";
import {
  extractEngineeringKnowledgeGraphFragment,
} from "../src/graph/knowledge-extraction";
import type { GraphNode } from "../src/core/types";

describe("engineering knowledge extraction", () => {
  it("classifies mixed English and Chinese requirements and concepts deterministically", () => {
    const first = extractEngineeringKnowledgeGraphFragment(
      "The ingestion module must retry failed writes.\n对话记录需要进入工程图谱。",
    );
    const second = extractEngineeringKnowledgeGraphFragment(
      "The   ingestion module must retry failed   writes.\n对话记录需要进入工程图谱。",
    );

    expect(first.nodes.map((node) => node.type)).toContain("Requirement");
    expect(first.nodes.filter((node) => node.type === "Requirement")).toHaveLength(2);
    expect(first.nodes.map((node) => node.content)).toEqual(
      expect.arrayContaining(["The ingestion module must retry failed writes.", "对话记录需要进入工程图谱。"])
    );

    const english = first.nodes.find((node) => node.type === "Requirement" && node.content.includes("ingestion"))!;
    const chinese = first.nodes.find((node) => node.type === "Requirement" && node.content.includes("对话记录"))!;
    expect(english.metadata?.cue).toBe("must");
    expect(chinese.metadata?.cue).toBe("需要");
    expect(english.id).toMatch(/^requirement:/);
    expect(chinese.id).toMatch(/^requirement:/);

    expect(second.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
  });

  it("deduplicates repeated concepts and preserves occurrence evidence", () => {
    const fragment = extractEngineeringKnowledgeGraphFragment({
      text: "`GraphClient.upsertNodes` is part of the storage API.",
      turns: [{ turnId: "t-1", query: "How does GraphClient.upsertNodes work?", reply: "" }],
    });

    const concepts = fragment.nodes.filter((node) => node.type === "Concept");
    const client = concepts.find((node) => node.content === "GraphClient.upsertNodes")!;
    expect(concepts.filter((node) => node.content === "GraphClient.upsertNodes")).toHaveLength(1);
    expect(client.id).toBe(`concept:${client.id.slice("concept:".length)}`);
    expect(client.metadata?.evidence).toHaveLength(2);
    expect(client.metadata?.sourceTurnIds).toEqual(["t-1"]);
    expect(client.metadata?.confidence).toBeGreaterThanOrEqual(0.94);
  });

  it("emits provenance from knowledge nodes to deterministic source nodes", async () => {
    const fragment = extractEngineeringKnowledgeGraphFragment(
      {
        turns: [
          {
            turnId: "turn-42",
            query: "",
            reply: "The transport protocol shall reject duplicate events.",
          },
        ],
      },
      { sourceNodeId: "file:docs/design.md" },
    );

    expect(fragment.edges).toContainEqual({
      from: expect.stringMatching(/^requirement:/),
      to: "file:docs/design.md",
      relation: "derived_from",
    });
    expect(fragment.edges.every((edge) => edge.relation === "derived_from")).toBe(true);
    expect(fragment.edges.every((edge) => edge.from.startsWith("concept:") || edge.from.startsWith("requirement:"))).toBe(true);

    const nodes: GraphNode[] = fragment.nodes;
    expect(nodes.every((node) => typeof node.metadata?.confidence === "number")).toBe(true);
  });

  it("returns no nodes or edges for empty and noisy input", () => {
    const empty = extractEngineeringKnowledgeGraphFragment("");
    const noise = extractEngineeringKnowledgeGraphFragment({
      text: "... \n ??? \n the and but",
      turns: [{ turnId: "", query: "???", reply: "..." }],
    });

    expect(empty).toEqual({ nodes: [], edges: [] });
    expect(noise.nodes).toEqual([]);
    expect(noise.edges).toEqual([]);
  });
});
