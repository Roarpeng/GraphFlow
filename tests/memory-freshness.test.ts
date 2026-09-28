import { describe, expect, it } from "vitest";
import {
  assessSkillFreshness,
  buildRefResolver,
  evaluateFreshnessPolicy,
  extractFreshnessRefs,
  isFreshnessDowngradeEnabled,
  isFreshnessEnabled,
  skillTextCorpus,
} from "../src/learning/memory-freshness";
import type { SkillState } from "../src/learning/skill-types";

function skill(overrides: Partial<SkillState> = {}): SkillState {
  return {
    id: "skill:test",
    name: "bridgeDagExecution",
    score: 3,
    uses: 4,
    lastOutcome: "pass",
    updatedAt: 1,
    ...overrides,
  };
}

describe("memory freshness oracle", () => {
  it("collects code refs from guidance, description and playbook", () => {
    const state = skill({
      guidance: "edit bridgeDagExecution before touching orchestrator",
      description: "keeps indexWorkspaceFiles honest",
      playbook: [{ id: "b1", text: "call createGraphClient once", helpful: 1, harmful: 0 }],
    });
    const corpus = skillTextCorpus(state);
    expect(corpus).toContain("bridgeDagExecution");
    const refs = extractFreshnessRefs(state);
    expect(refs).toContain("bridgeDagExecution");
    expect(refs).toContain("indexWorkspaceFiles");
    expect(refs).toContain("createGraphClient");
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("reports unknown when the skill carries no code refs", () => {
    const result = assessSkillFreshness(skill({ guidance: "keep the release notes tidy" }), () => true);
    expect(result.level).toBe("unknown");
    expect(result.totalRefs).toBe(0);
    expect(result.driftScore).toBe(0);
    expect(result.reason).toContain("cannot be judged");
  });

  it("is fresh when every learned ref still resolves", () => {
    const result = assessSkillFreshness(skill({ guidance: "edit bridgeDagExecution here" }), () => true);
    expect(result.level).toBe("fresh");
    expect(result.driftScore).toBe(0);
    expect(result.resolvedRefs).toBe(result.totalRefs);
  });

  it("grades drift into watch and stale by share of unresolved refs", () => {
    const state = skill({
      guidance: "edit bridgeDagExecution and indexWorkspaceFiles and createGraphClient and dagEngineRunner",
    });
    const oneDead = new Set(["indexWorkspaceFiles"]);
    const watch = assessSkillFreshness(state, (ref) => !oneDead.has(ref));
    expect(watch.level).toBe("watch");
    expect(watch.driftScore).toBeCloseTo(0.25);
    expect(watch.staleRefs).toEqual(["indexWorkspaceFiles"]);

    const threeDead = new Set(["indexWorkspaceFiles", "createGraphClient", "dagEngineRunner"]);
    const stale = assessSkillFreshness(state, (ref) => !threeDead.has(ref));
    expect(stale.level).toBe("stale");
    expect(stale.driftScore).toBeCloseTo(0.75);
    expect(stale.staleRefs).toHaveLength(3);
  });

  it("honours custom thresholds", () => {
    const state = skill({
      guidance: "edit bridgeDagExecution and indexWorkspaceFiles and createGraphClient and dagEngineRunner",
    });
    const threeDead = new Set(["indexWorkspaceFiles", "createGraphClient", "dagEngineRunner"]);
    const resolvable = (ref: string): boolean => !threeDead.has(ref);
    expect(assessSkillFreshness(state, resolvable).level).toBe("stale");
    expect(
      assessSkillFreshness(state, resolvable, { watchThreshold: 0.2, staleThreshold: 0.9 }).level
    ).toBe("watch");
  });

  it("demotes a stale proven skill but never a watch or canary-held one", () => {
    const stale = evaluateFreshnessPolicy({ level: "stale", outcomeKind: "proven" });
    expect(stale.downgrade).toBe(true);
    expect(stale.to).toBe("correctable");

    expect(evaluateFreshnessPolicy({ level: "watch", outcomeKind: "proven" }).downgrade).toBe(false);
    expect(
      evaluateFreshnessPolicy({ level: "stale", outcomeKind: "proven", canaryValidated: true }).downgrade
    ).toBe(false);
    expect(evaluateFreshnessPolicy({ level: "stale", outcomeKind: "anti-pattern" }).downgrade).toBe(false);
    expect(evaluateFreshnessPolicy({ level: "unknown" }).downgrade).toBe(false);
  });

  it("reads opt-in switches", () => {
    expect(isFreshnessEnabled({})).toBe(false);
    expect(isFreshnessEnabled({ GRAPHFLOW_FRESHNESS: "1" })).toBe(true);
    expect(isFreshnessEnabled({ GRAPHFLOW_FRESHNESS: "off" })).toBe(false);
    expect(isFreshnessDowngradeEnabled({ GRAPHFLOW_FRESHNESS_DOWNGRADE: "true" })).toBe(true);
  });
});

describe("buildRefResolver", () => {
  const nodes = [
    { id: "symbol:src/graph/context-slicer.ts:buildContextRefillManager:9f2a1c" },
    { id: "file:src/graph/context-slicer.ts" },
    { id: "symbol:src/learning/skill-flywheel.ts:updateSkillScore:44de90" },
  ];

  it("resolves a bare symbol name and a repo-relative file path", () => {
    const resolves = buildRefResolver(nodes);
    expect(resolves("buildContextRefillManager")).toBe(true);
    expect(resolves("updateSkillScore")).toBe(true);
    expect(resolves("src/graph/context-slicer.ts")).toBe(true);
    expect(resolves("graph/context-slicer.ts")).toBe(true);
  });

  it("does not resolve a symbol whose content hash moved on", () => {
    const resolves = buildRefResolver(nodes);
    expect(resolves("bridgeDagExecution")).toBe(false);
    expect(resolves("")).toBe(false);
  });
});
