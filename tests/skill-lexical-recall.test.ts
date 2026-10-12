import { describe, expect, it } from "vitest";
import { tokenizeBm25 } from "../src/graph/bm25";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphNode } from "../src/core/types";
import {
  SKILL_LEXICAL_PROMOTION_FLOOR,
  collectTaskSkillCandidates,
  suggestSkillConditionHints,
  suggestSkillHints,
} from "../src/learning/skill-flywheel";
import { parseCompositeState, parseSkillState, serializeAtomic, skillNodeId } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";

function state(partial: Partial<SkillState> & { id: string; name: string }): SkillState {
  return { score: 0, uses: 0, lastOutcome: "pass", updatedAt: 0, ...partial };
}

/**
 * Stub client simulating a name-biased keyword channel (the realistic case for
 * LIMIT-bounded SQL backends): queryByKeyword returns a skill only when the
 * skill NAME shares a token with the query. readSnapshot still exposes every
 * skill, which is exactly the gap the lexical channel closes — a skill whose
 * name never token-matches the task but whose playbook text does.
 */
function nameKeywordClient(nodes: GraphNode[]): GraphClient {
  const store = new Map(nodes.map((node) => [node.id, node]));
  const nameMatchesQuery = (node: GraphNode, query: string): boolean => {
    const parsed = parseCompositeState(node.content) ?? parseSkillState(node.content);
    if (!parsed) return false;
    const queryTokens = new Set(tokenizeBm25(query));
    return tokenizeBm25(parsed.name).some((token) => queryTokens.has(token));
  };
  return {
    upsertNodes: async (updates) => {
      for (const node of updates) {
        store.set(node.id, node);
      }
    },
    upsertEdges: async () => {},
    queryByKeyword: async (query) =>
      [...store.values()].filter((node) => node.type === "Skill" && nameMatchesQuery(node, query)),
    readSnapshot: () => ({ nodes: [...store.values()], edges: [] }),
  };
}

const promotionTask = "stabilize graphflow queue workers with exponential backoff";

function promotionGraph(): GraphNode[] {
  const largeSample = state({
    id: skillNodeId("queue-workers-guide"),
    name: "queue-workers-guide",
    uses: 50,
    successCount: 46,
    score: 3,
    outcomeKind: "proven",
    guidance: "graphflow queue notes",
  });
  const smallSample = state({
    id: skillNodeId("flaky-stabilize-triage"),
    name: "flaky-stabilize-triage",
    uses: 2,
    successCount: 2,
    score: 9, // higher heuristic score must NOT outweigh Wilson evidence
    outcomeKind: "proven",
    guidance: "graphflow triage notes",
  });
  // Name shares NO token with the task; only its playbook bullet matches.
  const lexicalOnly = state({
    id: skillNodeId("retry-budget-hints"),
    name: "retry-budget-hints",
    uses: 5,
    successCount: 4,
    score: 2,
    outcomeKind: "proven",
    playbook: [
      {
        id: "b1",
        text: "exponential backoff with jitter stabilize the queue workers in graphflow",
        helpful: 3,
        harmful: 0,
      },
    ],
  });
  // Only overlap with the task is "graphflow", present in EVERY doc: its IDF
  // saturates and the score stays below the promotion floor.
  const glueOnly = state({
    id: skillNodeId("glue-common-doc"),
    name: "glue-common-doc",
    uses: 3,
    score: 1,
    outcomeKind: "correctable",
    guidance: "graphflow everywhere",
  });
  return [
    { id: largeSample.id, type: "Skill", content: serializeAtomic(largeSample) },
    { id: smallSample.id, type: "Skill", content: serializeAtomic(smallSample) },
    { id: lexicalOnly.id, type: "Skill", content: serializeAtomic(lexicalOnly) },
    { id: glueOnly.id, type: "Skill", content: serializeAtomic(glueOnly) },
  ];
}

describe("hybrid lexical (BM25) skill recall", () => {
  it("promotes a playbook-matching skill the name channel missed, without displacing Wilson order", async () => {
    const client = nameKeywordClient(promotionGraph());

    const { ranked } = await collectTaskSkillCandidates(client, promotionTask);
    const names = ranked.map((hint) => hint.name);

    // Symbolically (name-token) matched skills keep the wave-1 Wilson-LB
    // contract: 46/50 evidence outranks 2/2 despite the lower heuristic score.
    expect(names[0]).toBe("queue-workers-guide");
    expect(names[1]).toBe("flaky-stabilize-triage");
    // The lexical-only skill enters AFTER every symbolically matched skill.
    expect(names).toEqual([
      "queue-workers-guide",
      "flaky-stabilize-triage",
      "retry-budget-hints",
    ]);

    const promoted = ranked[2];
    expect(promoted?.lexicalOnly).toBe(true);
    expect(promoted?.lexicalScore).toBeDefined();
    expect(promoted?.lexicalScore ?? 0).toBeGreaterThanOrEqual(SKILL_LEXICAL_PROMOTION_FLOOR);

    // Symbolic hints carry their lexical score as a secondary signal too.
    expect(ranked[0]?.lexicalScore ?? 0).toBeGreaterThan(0);
    expect(ranked[0]?.lexicalOnly).toBeUndefined();
  });

  it("rejects promotion below the floor (corpus-ubiquitous token only)", async () => {
    const client = nameKeywordClient(promotionGraph());
    const { ranked, avoid } = await collectTaskSkillCandidates(client, promotionTask);
    // "glue-common-doc" shares only the every-doc token "graphflow" with the
    // task — below SKILL_LEXICAL_PROMOTION_FLOOR, so it is neither ranked
    // nor avoided.
    expect(ranked.map((hint) => hint.name)).not.toContain("glue-common-doc");
    expect(avoid.map((hint) => hint.name)).not.toContain("glue-common-doc");
  });

  it("surfaces the promoted skill through the public hint API", async () => {
    const client = nameKeywordClient(promotionGraph());
    const hints = await suggestSkillConditionHints(client, promotionTask, 5);
    expect(hints.skillRefs).toContain("queue-workers-guide");
    expect(hints.skillRefs).toContain("retry-budget-hints");
  });

  it("breaks full heuristic ties by lexical score (never Wilson-separated ones)", async () => {
    // Equal evidence (2/2), equal score, equal uses: the lexical channel
    // decides. "query-relay" matches the rarer task term; "cache-*" only the
    // term shared by two docs.
    const s1 = state({
      id: skillNodeId("cache-parser"),
      name: "cache-parser",
      uses: 2,
      successCount: 2,
      score: 1,
      outcomeKind: "proven",
    });
    const s2 = state({
      id: skillNodeId("query-relay"),
      name: "query-relay",
      uses: 2,
      successCount: 2,
      score: 1,
      outcomeKind: "proven",
    });
    const s3 = state({
      id: skillNodeId("cache-notes"),
      name: "cache-notes",
      uses: 2,
      successCount: 2,
      score: 1,
      outcomeKind: "proven",
    });
    const client = nameKeywordClient(
      [s1, s2, s3].map((skill) => ({
        id: skill.id,
        type: "Skill",
        content: serializeAtomic(skill),
      }))
    );

    const { ranked } = await collectTaskSkillCandidates(client, "query cache parse");
    // Without the lexical tie-break the order would be alphabetical
    // (cache-notes, cache-parser, query-relay).
    expect(ranked.map((hint) => hint.name)).toEqual([
      "query-relay",
      "cache-notes",
      "cache-parser",
    ]);
  });

  it("is deterministic across runs on both stub and real clients", async () => {
    const stub = nameKeywordClient(promotionGraph());
    const first = await collectTaskSkillCandidates(stub, promotionTask);
    const second = await collectTaskSkillCandidates(stub, promotionTask);
    expect(second.ranked).toEqual(first.ranked);
    expect(second.avoid).toEqual(first.avoid);

    const real = new GraphifyClient();
    await real.upsertNodes(promotionGraph());
    const realFirst = await collectTaskSkillCandidates(real, promotionTask);
    const realSecond = await collectTaskSkillCandidates(real, promotionTask);
    expect(realSecond.ranked).toEqual(realFirst.ranked);

    const hintsA = await suggestSkillHints(real, promotionTask, 3);
    const hintsB = await suggestSkillHints(real, promotionTask, 3);
    expect(hintsB).toEqual(hintsA);
  });

  it("keeps recall working when the client exposes no snapshot (keyword set only)", async () => {
    const nodes = promotionGraph();
    const noSnapshotClient: GraphClient = {
      upsertNodes: async () => {},
      upsertEdges: async () => {},
      queryByKeyword: async (query) => {
        const queryTokens = new Set(tokenizeBm25(query));
        return nodes.filter((node) => {
          const parsed = parseSkillState(node.content);
          return parsed !== undefined && tokenizeBm25(parsed.name).some((t) => queryTokens.has(t));
        });
      },
    };
    const { ranked } = await collectTaskSkillCandidates(noSnapshotClient, promotionTask);
    // No snapshot → no lexical promotion, but symbolic recall still works.
    expect(ranked.map((hint) => hint.name)).toEqual([
      "queue-workers-guide",
      "flaky-stabilize-triage",
    ]);
  });
});
