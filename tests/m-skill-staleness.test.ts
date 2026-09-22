import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import { GraphifyClient } from "../src/graph/graphify-client";
import { parseSkillState, serializeAtomic, serializeComposite } from "../src/learning/skill-store";
import {
  isSkillRecallable,
  resolveSkillSymbolStatus,
  revalidateSkills,
  symbolLookupFromSet,
} from "../src/learning/skill-staleness";
import type { CompositeSkillState, SkillState } from "../src/learning/skill-types";
// M4 API must also be reachable through the flywheel module (wiring seam).
import {
  isSkillRecallable as isSkillRecallableFromFlywheel,
  revalidateSkills as revalidateSkillsFromFlywheel,
} from "../src/learning/skill-flywheel";

/**
 * Timestamp arithmetic is forbidden as a staleness judgement. Picking two
 * values ~130 years apart makes any accidental `now - updatedAt` rule visible.
 */
const FIXED_NOW = 1_700_000_000_000;
const FAR_FUTURE = 5_800_000_000_000;

function atomicSkill(state: Partial<SkillState> & { id: string; name: string }): SkillState {
  return {
    score: 1,
    uses: 1,
    lastOutcome: "pass",
    updatedAt: FIXED_NOW,
    ...state,
  };
}

function compositeSkill(
  state: Partial<CompositeSkillState> & { id: string; name: string }
): CompositeSkillState {
  return {
    parents: ["skill:planner-ts", "skill:auth-ts"],
    coOccurCount: 3,
    successCount: 3,
    failureCount: 0,
    score: 3,
    uses: 3,
    lastOutcome: "pass",
    updatedAt: FIXED_NOW,
    ...state,
  };
}

interface CountedClient {
  client: GraphClient;
  /** Number of upsertNodes calls — proves "no write" on repeat passes. */
  writeCalls: () => number;
}

/**
 * Minimal GraphClient wrapper: the in-memory client mutates node objects in
 * place, so counting writes is the only way to assert revalidateSkills stayed
 * read-only on its second pass.
 */
function countingClient(inner: GraphifyClient): CountedClient {
  let writeCalls = 0;
  return {
    client: {
      upsertNodes: async (nodes) => {
        writeCalls += 1;
        await inner.upsertNodes(nodes);
      },
      upsertEdges: (edges) => inner.upsertEdges(edges),
      queryByKeyword: (query) => inner.queryByKeyword(query),
      readSnapshot: () => inner.readSnapshot(),
    },
    writeCalls: () => writeCalls,
  };
}

function findNode(client: GraphifyClient, id: string): GraphNode {
  const node = client.snapshot().nodes.find((item) => item.id === id);
  if (!node) {
    throw new Error(`missing node ${id}`);
  }
  return node;
}

describe("deterministic skill symbol staleness (M4)", () => {
  it("keeps a skill live when every referenced symbol still resolves", () => {
    const status = resolveSkillSymbolStatus(
      {
        id: "skill:planner-ts",
        name: "planner.ts",
        guidance: "- split src/planner.ts into modules",
      },
      symbolLookupFromSet(["src/planner.ts", "planner.ts"]),
      { checkedAt: FIXED_NOW }
    );

    expect(status.stale).toBe(false);
    expect(status.reason).toBe("resolved");
    expect(status.missingSymbols).toEqual([]);
    expect([...status.checkedSymbols].sort()).toEqual(["planner.ts", "src/planner.ts"]);
    expect(status.checkedAt).toBe(FIXED_NOW);
  });

  it("reports exactly the symbols that no longer resolve", () => {
    const status = resolveSkillSymbolStatus(
      {
        id: "skill:auth-ts",
        name: "auth.ts",
        guidance: "1. patch auth.ts\n2. use cache-store.ts",
      },
      symbolLookupFromSet(["auth.ts"])
    );

    expect(status.stale).toBe(true);
    expect(status.reason).toBe("missing-symbols");
    expect(status.missingSymbols).toEqual(["cache-store.ts"]);
    expect([...status.checkedSymbols].sort()).toEqual(["auth.ts", "cache-store.ts"]);
  });

  it("distinguishes a fully vanished symbol set from a partial one", () => {
    const status = resolveSkillSymbolStatus(
      { id: "skill:auth-ts", name: "auth.ts", guidance: "1. patch auth.ts" },
      symbolLookupFromSet([])
    );

    expect(status.stale).toBe(true);
    expect(status.reason).toBe("all-symbols-missing");
    expect(status.missingSymbols).toEqual(["auth.ts"]);
  });

  it("never reports a symbol-less skill as stale (unverifiable is not invalid)", () => {
    const skill = {
      id: "skill:update-readme",
      name: "update readme",
      guidance: "- update the readme carefully",
    };

    // An empty lookup fails every symbol: if "no symbols" were conflated with
    // "stale", this honest skill would be retired.
    const status = resolveSkillSymbolStatus(skill, symbolLookupFromSet([]), {
      checkedAt: FIXED_NOW,
    });

    expect(status.stale).toBe(false);
    expect(status.reason).toBe("no-symbols");
    expect(status.checkedSymbols).toEqual([]);
    expect(status.missingSymbols).toEqual([]);
  });

  it("treats an explicitly bound symbol list as authoritative", () => {
    const skill = {
      id: "skill:cache-store",
      name: "cache-store.ts",
      symbols: ["CacheStore"],
    };

    const stale = resolveSkillSymbolStatus(skill, symbolLookupFromSet([]));
    expect(stale.checkedSymbols).toEqual(["CacheStore"]);
    expect(stale.missingSymbols).toEqual(["CacheStore"]);
    expect(stale.stale).toBe(true);

    const live = resolveSkillSymbolStatus(skill, symbolLookupFromSet(["CacheStore"]));
    expect(live.stale).toBe(false);
    expect(live.reason).toBe("resolved");
  });

  it("recovers a full identifier instead of checking a mid-identifier fragment", () => {
    // extractProjectSymbols' camelCase pattern starts after the leading capital
    // ("raphifyClient"); checking that fragment would wrongly retire the skill.
    const status = resolveSkillSymbolStatus(
      { id: "skill:bridge-ts", name: "bridge.ts", guidance: "call GraphifyClient from here" },
      symbolLookupFromSet(["bridge.ts", "GraphifyClient"])
    );

    expect(status.checkedSymbols).toContain("GraphifyClient");
    expect(status.checkedSymbols).not.toContain("raphifyClient");
    expect(status.stale).toBe(false);
    expect(status.reason).toBe("resolved");
  });

  it("treats a failing lookup as unknown, never as missing", () => {
    const status = resolveSkillSymbolStatus(
      { id: "skill:planner-ts", name: "planner.ts" },
      {
        hasSymbol: () => {
          throw new Error("symbol index unavailable");
        },
      }
    );

    expect(status.stale).toBe(false);
    expect(status.reason).toBe("lookup-error");
    expect(status.checkedSymbols).toEqual(["planner.ts"]);
  });

  it("judges staleness without consulting elapsed time", () => {
    const skill = { id: "skill:auth-ts", name: "auth.ts" };
    const lookup = symbolLookupFromSet(["auth.ts"]);

    const atZero = resolveSkillSymbolStatus(skill, lookup, { checkedAt: 0 });
    const atFarFuture = resolveSkillSymbolStatus(skill, lookup, { checkedAt: FAR_FUTURE });

    expect({ ...atZero, checkedAt: 0 }).toEqual({ ...atFarFuture, checkedAt: 0 });

    const missing = { id: "skill:planner-ts", name: "planner.ts" };
    const emptyLookup = symbolLookupFromSet([]);
    expect({ ...resolveSkillSymbolStatus(missing, emptyLookup, { checkedAt: 0 }), checkedAt: 0 }).toEqual({
      ...resolveSkillSymbolStatus(missing, emptyLookup, { checkedAt: FAR_FUTURE }),
      checkedAt: 0,
    });
  });

  it("retires stale skills once and reports no-symbol skills separately", async () => {
    const inner = new GraphifyClient();
    const stale = atomicSkill({ id: "skill:a-stale", name: "planner.ts" });
    const live = atomicSkill({ id: "skill:b-live", name: "auth.ts" });
    const generic = atomicSkill({ id: "skill:c-generic", name: "update readme" });
    await inner.upsertNodes([
      { id: stale.id, type: "Skill", content: serializeAtomic(stale) },
      { id: live.id, type: "Skill", content: serializeAtomic(live) },
      { id: generic.id, type: "Skill", content: serializeAtomic(generic) },
    ]);

    const { client, writeCalls } = countingClient(inner);
    const options = { lookup: symbolLookupFromSet(["auth.ts"]), now: () => FIXED_NOW };

    const first = await revalidateSkills(client, options);
    expect(first.checked).toBe(3);
    expect(first.stale).toBe(1);
    expect(first.retired).toBe(1);
    expect(first.staleSkillIds).toEqual(["skill:a-stale"]);
    expect(first.noSymbolsSkillIds).toEqual(["skill:c-generic"]);
    expect(first.checkedAt).toBe(FIXED_NOW);
    expect(writeCalls()).toBe(1);

    // Soft marker only: nothing is deleted, and the decay inputs are untouched
    // so deterministic invalidation cannot feed the time-decay curve.
    const staleNode = findNode(inner, "skill:a-stale");
    const staleState = parseSkillState(staleNode.content);
    expect(staleState?.hidden).toBe(true);
    expect(staleState?.updatedAt).toBe(FIXED_NOW);
    expect(staleNode.metadata?.unrecallable).toBe(true);
    expect(staleNode.metadata?.staleReason).toBe("all-symbols-missing");
    expect(staleNode.metadata?.staleMissingSymbols).toEqual(["planner.ts"]);
    expect(staleNode.metadata?.staleCheckedAt).toBe(FIXED_NOW);
    expect(isSkillRecallable(staleNode)).toBe(false);

    // Healthy and unverifiable skills are left completely alone.
    const liveNode = findNode(inner, "skill:b-live");
    expect(parseSkillState(liveNode.content)?.hidden).toBeUndefined();
    expect(liveNode.metadata).toBeUndefined();
    expect(isSkillRecallable(liveNode)).toBe(true);

    const genericNode = findNode(inner, "skill:c-generic");
    expect(genericNode.metadata).toBeUndefined();
    expect(isSkillRecallable(genericNode)).toBe(true);

    const second = await revalidateSkills(client, options);
    expect(second.retired).toBe(0);
    expect(second.stale).toBe(1);
    expect(second.staleSkillIds).toEqual(first.staleSkillIds);
    expect(second.noSymbolsSkillIds).toEqual(first.noSymbolsSkillIds);
    // Idempotent also in writes: a repeat pass never re-upserts.
    expect(writeCalls()).toBe(1);
  });

  it("marks a stale composite skill unrecallable without rewriting its content", async () => {
    const inner = new GraphifyClient();
    const composite = compositeSkill({
      id: "skill:composite:auth-ts__planner-ts",
      name: "planner.ts+auth.ts",
      outcomeKind: "proven",
    });
    const content = serializeComposite(composite);
    await inner.upsertNodes([
      { id: composite.id, type: "Skill", content },
    ]);

    const { client } = countingClient(inner);
    const options = { lookup: symbolLookupFromSet(["auth.ts"]), now: () => FIXED_NOW };

    const first = await revalidateSkills(client, options);
    expect(first.checked).toBe(1);
    expect(first.retired).toBe(1);
    expect(first.staleSkillIds).toEqual([composite.id]);

    const node = findNode(inner, composite.id);
    expect(node.content).toBe(content);
    expect(node.metadata?.unrecallable).toBe(true);
    expect(isSkillRecallable(node)).toBe(false);

    const second = await revalidateSkills(client, options);
    expect(second.retired).toBe(0);
  });

  it("never retires a skill because it is old", async () => {
    const inner = new GraphifyClient();
    const ancient = atomicSkill({
      id: "skill:ancient-ts",
      name: "ancient.ts",
      uses: 9,
      score: 8,
      updatedAt: 0,
      lastDecayedAt: 0,
      outcomeKind: "proven",
    });
    await inner.upsertNodes([{ id: ancient.id, type: "Skill", content: serializeAtomic(ancient) }]);

    const { client, writeCalls } = countingClient(inner);
    const result = await revalidateSkills(client, {
      lookup: symbolLookupFromSet(["ancient.ts"]),
      now: () => FAR_FUTURE,
    });

    expect(result.stale).toBe(0);
    expect(result.retired).toBe(0);
    expect(writeCalls()).toBe(0);

    const node = findNode(inner, ancient.id);
    expect(parseSkillState(node.content)?.hidden).toBeUndefined();
    expect(parseSkillState(node.content)?.updatedAt).toBe(0);
    expect(isSkillRecallable(node)).toBe(true);
  });

  it("refuses recall for hidden, unrecallable, noise and non-skill nodes", () => {
    const hidden = atomicSkill({ id: "skill:hidden-ts", name: "hidden.ts", hidden: true });
    const unrecallable: GraphNode = {
      id: "skill:unrecallable-ts",
      type: "Skill",
      content: serializeAtomic(atomicSkill({ id: "skill:unrecallable-ts", name: "unrecallable.ts" })),
      metadata: { unrecallable: true },
    };
    const noise = atomicSkill({ id: "skill:noise", name: "noise", outcomeKind: "noise" });

    expect(isSkillRecallable({ id: hidden.id, type: "Skill", content: serializeAtomic(hidden) })).toBe(
      false
    );
    expect(isSkillRecallable(unrecallable)).toBe(false);
    expect(isSkillRecallable({ id: noise.id, type: "Skill", content: serializeAtomic(noise) })).toBe(
      false
    );
    expect(
      isSkillRecallable({ id: "file:src/a.ts", type: "File", content: "src/a.ts" })
    ).toBe(false);
    // Valid JSON that is neither an atomic nor a composite skill shape.
    expect(
      isSkillRecallable({ id: "skill:broken", type: "Skill", content: '{"kind":"unknown"}' })
    ).toBe(false);
  });

  it("exposes the M4 API through skill-flywheel", () => {
    expect(revalidateSkillsFromFlywheel).toBe(revalidateSkills);
    expect(isSkillRecallableFromFlywheel).toBe(isSkillRecallable);
  });
});
