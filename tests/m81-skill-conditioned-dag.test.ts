import { describe, expect, it } from "vitest";
import {
  attachSkillConditionToPlanNodes,
  buildAgentDelegatedSimplePlan,
} from "../src/core/agent-delegation";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  suggestSkillConditionHints,
} from "../src/learning/skill-flywheel";
import { skillNodeId, serializeAtomic, parseSkillState } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";
import {
  optimizeSkillLite,
} from "../src/learning/skill-opt-lite";

describe("P1 skill-conditioned DAG", () => {
  it("attaches skillRefs and avoidPatterns onto plan nodes", () => {
    const nodes = attachSkillConditionToPlanNodes(
      [
        { id: "task-1", description: "design", dependencies: [] },
        { id: "task-2", description: "implement", dependencies: ["task-1"] },
      ],
      {
        skillRefs: ["refactor planner.ts"],
        avoidPatterns: ["update readme"],
      }
    );
    expect(nodes[0]?.skillRefs).toEqual(["refactor planner.ts"]);
    expect(nodes[0]?.avoidPatterns).toEqual(["update readme"]);
    expect(nodes[1]?.skillRefs).toEqual(["refactor planner.ts"]);
  });

  it("buildAgentDelegatedSimplePlan injects skill condition into nodes and bridge text", () => {
    const result = buildAgentDelegatedSimplePlan("refactor planner.ts and add tests", {
      skillRefs: ["refactor planner.ts"],
      avoidPatterns: ["blind rewrite"],
    });
    expect(result.nodes.every((n) => n.skillRefs?.includes("refactor planner.ts"))).toBe(true);
    expect(result.nodes.every((n) => n.avoidPatterns?.includes("blind rewrite"))).toBe(true);
    expect(result.agentInstructions).toContain("review proven/correctable skills");
    expect(result.agentInstructions).toContain("refactor planner.ts");
    expect(result.agentInstructions).toContain("Avoid known anti-patterns");
    expect(result.agentWorkItems.find((i) => i.id === "simple-plan-decomposition")?.prompt).toContain(
      "skillRefs"
    );
    // JSON shape remains backward compatible (id/description/dependencies still present).
    for (const node of result.nodes) {
      expect(node.id).toBeTruthy();
      expect(node.description).toBeTruthy();
      expect(Array.isArray(node.dependencies)).toBe(true);
    }
  });

  it("suggestSkillConditionHints separates proven refs from anti-patterns", async () => {
    const client = new GraphifyClient();
    const now = Date.now();
    const proven: SkillState = {
      id: skillNodeId("refactor"),
      name: "refactor",
      score: 2,
      uses: 3,
      lastOutcome: "pass",
      updatedAt: now,
      hasSymbolEvidence: true,
      outcomeKind: "proven",
    };
    const anti: SkillState = {
      id: skillNodeId("blind rewrite"),
      name: "blind rewrite",
      score: -2,
      uses: 4,
      lastOutcome: "fail",
      failStreak: 2,
      updatedAt: now,
      hasSymbolEvidence: true,
      outcomeKind: "anti-pattern",
    };
    await client.upsertNodes([
      { id: proven.id, type: "Skill", content: serializeAtomic(proven) },
      { id: anti.id, type: "Skill", content: serializeAtomic(anti) },
    ]);

    const hints = await suggestSkillConditionHints(
      client,
      "refactor planner.ts and avoid blind rewrite",
      3
    );
    expect(hints.skillRefs).toContain("refactor");
    expect(hints.avoidPatterns).toContain("blind rewrite");
    expect(hints.skillRefs).not.toContain("blind rewrite");
  });
});

describe("P1 SkillOpt-lite", () => {
  it("accepts bounded edits only when validation score improves", () => {
    const result = optimizeSkillLite({
      skillText: ["- update readme", "- refactor module"].join("\n"),
      lessons: ["Prefer targeted edits in planner.ts before broad refactors"],
      maxEdits: 3,
    });
    expect(result.appliedEdits.length).toBeGreaterThan(0);
    expect(result.appliedEdits.length).toBeLessThanOrEqual(3);
    expect(result.scoreAfter).toBeGreaterThan(result.scoreBefore);
    expect(result.improved).toBe(true);
    expect(result.optimizedText).toContain("planner.ts");
    expect(result.optimizedText.toLowerCase()).not.toContain("update readme");
  });

  it("keeps rejected edits in the buffer when score does not improve", () => {
    const result = optimizeSkillLite({
      skillText: "- keep goal-anchor.ts checks and GraphifyClient wiring",
      lessons: ["Prefer tiny note without symbols"],
      maxEdits: 3,
      // Reject everything so proposals land in rejectedEdits.
      validate: () => 0,
    });
    expect(result.improved).toBe(false);
    expect(result.appliedEdits).toEqual([]);
    expect(result.rejectedEdits.length).toBeGreaterThan(0);
  });

  it("respects maxEdits budget and parks overflow in rejectedEdits", () => {
    const result = optimizeSkillLite({
      skillText: "- update readme",
      lessons: [
        "Touch only planner.ts",
        "Add regression in skill-flywheel.ts",
        "Verify goal-anchor.ts",
        "Document GraphifyClient usage",
      ],
      maxEdits: 2,
    });
    expect(result.appliedEdits.length).toBeLessThanOrEqual(2);
    expect(result.rejectedEdits.some((e) => e.reason?.includes("budget"))).toBe(true);
  });

  it("applySkillLearning stores SkillOpt guidance when lessons improve score", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(
      client,
      "refactor planner.ts and add tests",
      { status: "COMPLETED", attempts: 1, feedback: "done" },
      ["Prefer surgical edits in planner.ts with symbol evidence"],
      { linked: true }
    );
    const skills = client
      .snapshot()
      .nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"));
    expect(skills.length).toBeGreaterThan(0);
    const withGuidance = skills
      .map((n) => parseSkillState(n.content))
      .filter((s): s is SkillState => Boolean(s?.guidance));
    expect(withGuidance.length).toBeGreaterThan(0);
    expect(withGuidance.some((s) => s.guidance?.includes("planner.ts"))).toBe(true);
  });
});
