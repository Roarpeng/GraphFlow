import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  SKILL_DRIFT_DEFAULT_THRESHOLD,
  computeSkillDrift,
} from "../src/learning/skill-drift";
import type { DriftEmbeddingProvider } from "../src/learning/skill-drift";
import {
  isSkillRecallable,
  revalidateSkills,
  resolveSkillStaleness,
  resolveSkillSymbolStatus,
  symbolLookupFromSet,
} from "../src/learning/skill-staleness";
import { parseSkillState, serializeAtomic } from "../src/learning/skill-store";
import type { GraphNode } from "../src/core/types";

const FIXED_NOW = 1_700_000_000_000;

/**
 * Deterministic topic embedder: each matcher maps a text to a fixed vector.
 * Matchers are consulted in order and the FIRST hit wins, so tests control
 * exactly which "topic" every string lands on. A non-hash fingerprint makes
 * the provider pass the semantic gate.
 */
function topicEmbeddingProvider(
  topics: Array<{ match: RegExp; vector: number[] }>,
  fingerprint = "mock-semantic-model"
): DriftEmbeddingProvider {
  return {
    fingerprint: () => fingerprint,
    async embed(text: string): Promise<number[]> {
      const lower = text.toLowerCase();
      const hit = topics.find((topic) => topic.match.test(lower));
      if (!hit) {
        throw new Error(`no topic vector for: ${text}`);
      }
      return [...hit.vector];
    },
  };
}

const PLANNER = [1, 0, 0, 0];
const AUTH = [0, 1, 0, 0];

const plannerVsAuth = topicEmbeddingProvider([
  { match: /jwt|token|auth/, vector: AUTH },
  { match: /planner|steps|small/, vector: PLANNER },
]);

describe("computeSkillDrift", () => {
  it("flags orthogonal skill text and symbol summaries as drifted", async () => {
    const result = await computeSkillDrift(
      { name: "planner.ts", guidance: "- keep planner steps small" },
      ["function authenticateUser @src/auth.ts:12 # validates jwt bearer tokens"],
      plannerVsAuth
    );
    expect(result.drifted).toBe(true);
    expect(result.distance).toBeCloseTo(1, 6);
    expect(result.threshold).toBe(SKILL_DRIFT_DEFAULT_THRESHOLD);
    expect(result.skipped).toBeUndefined();
  });

  it("keeps a skill whose text matches its symbols' summaries", async () => {
    const result = await computeSkillDrift(
      { name: "planner.ts", guidance: "- keep planner steps small" },
      ["planner.ts keeps the planner steps small"],
      plannerVsAuth
    );
    expect(result.drifted).toBe(false);
    expect(result.distance).toBeCloseTo(0, 6);
    expect(result.skipped).toBeUndefined();
  });

  it("compares against the MEAN of the per-symbol embeddings (equal weight per symbol)", async () => {
    // Two grounded symbols: one still planner-ish, one auth-ish. The centroid
    // [0.5, 0.5] sits at cos distance 1 - 1/sqrt(2) from the planner skill
    // text — below the default threshold, i.e. one drifted symbol among two
    // does not (yet) retire the skill.
    const result = await computeSkillDrift(
      { name: "planner.ts", guidance: "- planner steps stay small" },
      ["planner steps stay small", "validates jwt bearer tokens"],
      plannerVsAuth
    );
    expect(result.drifted).toBe(false);
    expect(result.distance).toBeCloseTo(1 - Math.SQRT1_2, 6);
  });

  it("applies a configurable threshold", async () => {
    const options = { threshold: 1 - Math.SQRT1_2 - 0.01 };
    const result = await computeSkillDrift(
      { name: "planner.ts", guidance: "- planner steps stay small" },
      ["planner steps stay small", "validates jwt bearer tokens"],
      plannerVsAuth,
      options
    );
    expect(result.threshold).toBe(options.threshold);
    expect(result.drifted).toBe(true);
  });

  it("skips (never drifts) on a hash fingerprint without embedding anything", async () => {
    let embedCalls = 0;
    const hashProvider: DriftEmbeddingProvider = {
      fingerprint: () => "fnv1a-384",
      async embed(): Promise<number[]> {
        embedCalls += 1;
        return [1, 0];
      },
    };
    const result = await computeSkillDrift(
      { name: "planner.ts", guidance: "- planner steps small" },
      ["validates jwt bearer tokens"],
      hashProvider
    );
    expect(result).toEqual({
      drifted: false,
      distance: -1,
      threshold: SKILL_DRIFT_DEFAULT_THRESHOLD,
      skipped: "hash-or-missing-provider",
    });
    expect(embedCalls).toBe(0);
  });

  it("skips on a missing fingerprint (unsettled resilient provider)", async () => {
    const pending: DriftEmbeddingProvider = {
      async embed() {
        return [1, 0];
      },
    };
    const result = await computeSkillDrift({ name: "a" }, ["b"], pending);
    expect(result.drifted).toBe(false);
    expect(result.distance).toBe(-1);
    expect(result.skipped).toBe("hash-or-missing-provider");
  });

  it("reports not-drifted when embedding throws (failure-safe)", async () => {
    const exploding: DriftEmbeddingProvider = {
      fingerprint: () => "mock-semantic-model",
      async embed() {
        throw new Error("model unavailable");
      },
    };
    const result = await computeSkillDrift(
      { name: "planner.ts", guidance: "- planner steps small" },
      ["validates jwt bearer tokens"],
      exploding
    );
    expect(result.drifted).toBe(false);
    expect(result.distance).toBe(-1);
    expect(result.skipped).toBe("embedding-error");
  });

  it("skips when either side has no text to compare", async () => {
    const result = await computeSkillDrift({ name: "" }, [], plannerVsAuth);
    expect(result.drifted).toBe(false);
    expect(result.skipped).toBe("no-text");
  });

  it("strips bullet markers from guidance before embedding", async () => {
    const seen: string[] = [];
    const recorder: DriftEmbeddingProvider = {
      fingerprint: () => "mock-semantic-model",
      async embed(text) {
        seen.push(text);
        return [1, 0];
      },
    };
    await computeSkillDrift(
      { name: "planner.ts", guidance: "- keep planner small\n- * another bullet" },
      ["planner summary"],
      recorder
    );
    expect(seen[0]).toBe("planner.ts\nkeep planner small\n* another bullet");
  });
});

describe("semantic drift wired into skill staleness", () => {
  function driftGraph(): GraphifyClient {
    const client = new GraphifyClient();
    return client;
  }

  /** File node the skill's symbols resolve against; its jsdoc is the "current meaning". */
  function fileNode(jsdoc: string): GraphNode {
    return {
      id: "file:src/planner.ts",
      type: "File",
      content: "src/planner.ts",
      metadata: { path: "src/planner.ts", jsdoc },
    };
  }

  const driftedSkill = {
    id: "skill:planner-ts",
    name: "planner.ts",
    guidance: "- keep planner steps small",
  };

  it("returns semantic-drift when symbols resolve but their summaries moved away", async () => {
    const client = driftGraph();
    await client.upsertNodes([
      fileNode("now hosts jwt authentication and bearer token validation"),
    ]);

    const status = await resolveSkillStaleness(client, driftedSkill, {
      checkedAt: FIXED_NOW,
      embeddingProvider: plannerVsAuth,
    });

    expect(status.stale).toBe(true);
    expect(status.reason).toBe("semantic-drift");
    // Symbols all resolve — this is drift, not disappearance.
    expect(status.missingSymbols).toEqual([]);
    expect(status.checkedSymbols).toContain("planner.ts");
    expect(status.drift?.distance).toBeCloseTo(1, 6);
    expect(status.drift?.threshold).toBe(SKILL_DRIFT_DEFAULT_THRESHOLD);
    expect(status.drift?.skipped).toBeUndefined();
  });

  it("stays resolved when the summaries still match the skill text", async () => {
    const client = driftGraph();
    await client.upsertNodes([fileNode("keeps the planner steps small")]);

    const status = await resolveSkillStaleness(client, driftedSkill, {
      checkedAt: FIXED_NOW,
      embeddingProvider: plannerVsAuth,
    });

    expect(status.stale).toBe(false);
    expect(status.reason).toBe("resolved");
    expect(status.drift?.distance).toBeCloseTo(0, 6);
  });

  it("is byte-for-byte the deterministic symbol check when no provider is supplied", async () => {
    const client = driftGraph();
    await client.upsertNodes([fileNode("now hosts jwt authentication")]);

    const viaWrapper = await resolveSkillStaleness(client, driftedSkill, {
      checkedAt: FIXED_NOW,
    });
    const direct = resolveSkillSymbolStatus(
      driftedSkill,
      symbolLookupFromSet(["planner.ts", "src/planner.ts"]),
      { checkedAt: FIXED_NOW }
    );
    expect(viaWrapper).toEqual(direct);
  });

  it("keeps a hash provider identical to no provider (offline default)", async () => {
    const client = driftGraph();
    await client.upsertNodes([fileNode("now hosts jwt authentication")]);
    const hashProvider: DriftEmbeddingProvider = {
      fingerprint: () => "fnv1a-384",
      async embed() {
        throw new Error("must not be called");
      },
    };

    const status = await resolveSkillStaleness(client, driftedSkill, {
      checkedAt: FIXED_NOW,
      embeddingProvider: hashProvider,
    });
    expect(status.stale).toBe(false);
    expect(status.reason).toBe("resolved");
    expect(status.drift?.skipped).toBe("hash-or-missing-provider");
    expect(status.drift?.distance).toBe(-1);
  });

  it("never reports drift when the embedding layer fails", async () => {
    const client = driftGraph();
    await client.upsertNodes([fileNode("now hosts jwt authentication")]);
    const exploding: DriftEmbeddingProvider = {
      fingerprint: () => "mock-semantic-model",
      async embed() {
        throw new Error("model unavailable");
      },
    };

    const status = await resolveSkillStaleness(client, driftedSkill, {
      checkedAt: FIXED_NOW,
      embeddingProvider: exploding,
    });
    expect(status.stale).toBe(false);
    expect(status.reason).toBe("resolved");
    expect(status.drift?.skipped).toBe("embedding-error");
  });

  it("missing symbols stay the stronger, precise reason", async () => {
    const client = driftGraph(); // no planner.ts file at all
    const status = await resolveSkillStaleness(client, driftedSkill, {
      checkedAt: FIXED_NOW,
      embeddingProvider: plannerVsAuth,
    });
    expect(status.stale).toBe(true);
    expect(status.reason).toBe("all-symbols-missing");
  });

  it("revalidateSkills retires drifted skills so isSkillRecallable is false", async () => {
    const client = driftGraph();
    const skill = {
      id: "skill:planner-ts",
      name: "planner.ts",
      score: 4,
      uses: 6,
      lastOutcome: "pass" as const,
      updatedAt: FIXED_NOW,
      outcomeKind: "proven" as const,
    };
    await client.upsertNodes([
      fileNode("now hosts jwt authentication and bearer token validation"),
      { id: skill.id, type: "Skill", content: serializeAtomic(skill) },
    ]);

    const first = await revalidateSkills(client, {
      lookup: symbolLookupFromSet(["planner.ts", "src/planner.ts"]),
      now: () => FIXED_NOW,
      embeddingProvider: plannerVsAuth,
    });
    expect(first.stale).toBe(1);
    expect(first.retired).toBe(1);
    expect(first.staleSkillIds).toEqual(["skill:planner-ts"]);

    const node = client.snapshot().nodes.find((n) => n.id === "skill:planner-ts");
    expect(node?.metadata?.staleReason).toBe("semantic-drift");
    expect(node?.metadata?.unrecallable).toBe(true);
    expect(parseSkillState(node?.content ?? "")?.hidden).toBe(true);
    expect(isSkillRecallable(node ?? ({ id: "x", type: "Skill", content: "" } as GraphNode))).toBe(false);

    // Idempotent retirement on the second pass.
    const second = await revalidateSkills(client, {
      lookup: symbolLookupFromSet(["planner.ts", "src/planner.ts"]),
      now: () => FIXED_NOW,
      embeddingProvider: plannerVsAuth,
    });
    expect(second.retired).toBe(0);
    expect(second.stale).toBe(1);
  });

  it("revalidateSkills without a provider keeps today's behavior (drift invisible)", async () => {
    const client = driftGraph();
    const skill = {
      id: "skill:planner-ts",
      name: "planner.ts",
      score: 4,
      uses: 6,
      lastOutcome: "pass" as const,
      updatedAt: FIXED_NOW,
      outcomeKind: "proven" as const,
    };
    await client.upsertNodes([
      fileNode("now hosts jwt authentication and bearer token validation"),
      { id: skill.id, type: "Skill", content: serializeAtomic(skill) },
    ]);

    const result = await revalidateSkills(client, {
      lookup: symbolLookupFromSet(["planner.ts", "src/planner.ts"]),
      now: () => FIXED_NOW,
    });
    expect(result.stale).toBe(0);
    expect(result.retired).toBe(0);
    const node = client.snapshot().nodes.find((n) => n.id === "skill:planner-ts");
    expect(node?.metadata).toBeUndefined();
    expect(isSkillRecallable(node ?? ({ id: "x", type: "Skill", content: "" } as GraphNode))).toBe(true);
  });
});
