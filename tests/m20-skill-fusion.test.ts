import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  composeSkillId,
  loadCompositeSkill,
  suggestSkillHints,
} from "../src/learning/skill-flywheel";

const TASK = "refactor module and add tests";

describe("M20 skill fusion", () => {
  it("synthesizes a composite skill with prerequisite edges after 2 successful runs", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "ok" });
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "ok" });

    const compositeId = composeSkillId("refactor", "tests");
    const composite = await loadCompositeSkill(client, compositeId);
    expect(composite).toBeDefined();
    expect(composite!.name).toBe("refactor+tests");
    expect(composite!.successCount).toBeGreaterThanOrEqual(2);
    expect(composite!.score).toBeGreaterThan(0);

    const snapshot = client.snapshot();
    const node = snapshot.nodes.find((n) => n.id === compositeId);
    expect(node).toBeDefined();
    expect(JSON.parse(node!.content).kind).toBe("composite");

    const prereqEdges = snapshot.edges.filter(
      (e) => e.relation === "prerequisite" && e.to === compositeId
    );
    const fromAtoms = new Set(prereqEdges.map((e) => e.from));
    expect(fromAtoms.has(`skill:refactor`)).toBe(true);
    expect(fromAtoms.has(`skill:tests`)).toBe(true);
  });

  it("does not emit prerequisite edges after a single successful run", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "ok" });

    const compositeId = composeSkillId("refactor", "tests");
    const composite = await loadCompositeSkill(client, compositeId);
    expect(composite).toBeDefined();
    expect(composite!.coOccurCount).toBe(1);
    expect(composite!.successCount).toBe(1);

    const prereq = client
      .snapshot()
      .edges.filter((e) => e.relation === "prerequisite" && e.to === compositeId);
    expect(prereq.length).toBe(0);
  });

  it("includes the composite fused name in hints before equal-score atomic skills", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "ok" });
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "ok" });

    const hints = await suggestSkillHints(client, "refactor service and add tests", 5);
    expect(hints).toContain("refactor+tests");

    const fusedIdx = hints.indexOf("refactor+tests");
    const refactorIdx = hints.indexOf("refactor");
    const testsIdx = hints.indexOf("tests");
    if (refactorIdx !== -1) {
      expect(fusedIdx).toBeLessThan(refactorIdx);
    }
    if (testsIdx !== -1) {
      expect(fusedIdx).toBeLessThan(testsIdx);
    }
  });

  it("increments failureCount and reflects negative score on a failed run", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, TASK, { status: "FAILED", attempts: 1, feedback: "nope" });

    const composite = await loadCompositeSkill(client, composeSkillId("refactor", "tests"));
    expect(composite).toBeDefined();
    expect(composite!.failureCount).toBe(1);
    expect(composite!.successCount).toBe(0);
    expect(composite!.score).toBe(-1);
    expect(composite!.lastOutcome).toBe("fail");
  });
});
