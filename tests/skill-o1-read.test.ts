import { describe, expect, it, vi } from "vitest";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphNode } from "../src/core/types";
import { loadCompositeSkill, readSkillState, serializeAtomic, serializeComposite } from "../src/learning/skill-store";
import { skillNodeId } from "../src/learning/skill-store";
import type { CompositeSkillState, SkillState } from "../src/learning/skill-types";

function skillNode(id: string, content: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return { id, type: "Skill", content, ...overrides };
}

function fakeClient(nodes: GraphNode[], withDirectLookup = true) {
  const queryByKeyword = vi.fn(async () => nodes);
  const getNodesByIds = withDirectLookup
    ? vi.fn(async (ids: string[]) => nodes.filter((node) => ids.includes(node.id)))
    : undefined;

  return {
    queryByKeyword,
    getNodesByIds,
    client: { queryByKeyword, getNodesByIds } as unknown as GraphClient,
  };
}

describe("O(1) skill reads", () => {
  it("uses direct backend lookup and avoids queryByKeyword", async () => {
    const state: SkillState = {
      id: "skill:add-tests",
      name: "add tests",
      score: 1,
      uses: 2,
      lastOutcome: "pass",
      updatedAt: 1,
    };
    const nodes = [
      skillNode("skill:other", serializeAtomic({ ...state, id: "skill:other", name: "other" })),
      skillNode("skill:add-tests", serializeAtomic(state)),
      skillNode("skill:add-tests", JSON.stringify("{invalid")),
    ];
    const { client, getNodesByIds, queryByKeyword } = fakeClient(nodes);

    await expect(readSkillState(client, "skill:add-tests")).resolves.toEqual(state);
    expect(getNodesByIds).toHaveBeenCalledWith(["skill:add-tests"]);
    expect(queryByKeyword).not.toHaveBeenCalled();
  });

  it("falls back when getNodesByIds is absent", async () => {
    const state: CompositeSkillState = {
      id: "skill:composite:a__b",
      name: "a + b",
      parents: ["a", "b"],
      coOccurCount: 2,
      successCount: 1,
      failureCount: 0,
      score: 1,
      uses: 1,
      lastOutcome: "pass",
      updatedAt: 1,
    };
    const nodes = [skillNode(state.id, serializeComposite(state))];
    const { client, queryByKeyword } = fakeClient(nodes, false);

    await expect(loadCompositeSkill(client, state.id)).resolves.toEqual(state);
    expect(queryByKeyword).toHaveBeenCalledTimes(1);
  });

  it("falls back when the direct result is empty", async () => {
    const state: SkillState = {
      id: skillNodeId("add tests"),
      name: "add tests",
      score: 0,
      uses: 1,
      lastOutcome: "pass",
      updatedAt: 1,
    };
    const nodes = [skillNode(state.id, serializeAtomic(state))];
    const { client, getNodesByIds, queryByKeyword } = fakeClient(nodes);
    getNodesByIds?.mockResolvedValue([]);

    await expect(readSkillState(client, state.id)).resolves.toEqual(state);
    expect(getNodesByIds).toHaveBeenCalledTimes(1);
    expect(queryByKeyword).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Skill and malformed nodes while selecting the exact Skill node", async () => {
    const state: SkillState = {
      id: "skill:add-tests",
      name: "add tests",
      score: 3,
      uses: 4,
      lastOutcome: "pass",
      updatedAt: 1,
    };
    const nodes = [
      skillNode("skill:add-tests", serializeAtomic(state), { type: "Concept" }),
      skillNode("skill:add-tests", serializeAtomic(state)),
      skillNode("skill:add-tests", "{not json"),
    ];
    const { client, getNodesByIds, queryByKeyword } = fakeClient(nodes);

    await expect(readSkillState(client, "skill:add-tests")).resolves.toEqual(state);
    expect(getNodesByIds).toHaveBeenCalledTimes(1);
    expect(queryByKeyword).not.toHaveBeenCalled();
  });
});
