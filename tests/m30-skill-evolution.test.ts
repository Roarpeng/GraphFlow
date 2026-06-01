import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  composeSkillId,
  loadCompositeSkill,
  suggestSkillHints,
  evolveCompositeSkillLlm,
} from "../src/learning/skill-flywheel";

const TASK = "develop and ts-type";

describe("M30 MiniCPM Skill Cognitive Evolution", () => {
  it("evolves composite skill through Mock MiniCPM-1B model and verifies nodes and fields", async () => {
    const client = new GraphifyClient();
    
    const mockComposite = {
      id: "skill:composite:develop__ts-type",
      name: "develop+ts-type",
      parents: ["skill:develop", "skill:ts-type"],
      coOccurCount: 2,
      successCount: 2,
      failureCount: 0,
      score: 2,
      uses: 1,
      lastOutcome: "pass" as const,
      updatedAt: Date.now(),
    };

    const node = await evolveCompositeSkillLlm(client, "develop", "ts-type", mockComposite);
    expect(node).not.toBeNull();
    expect(node!.type).toBe("Skill");
    
    const record = JSON.parse(node!.content);
    expect(record.kind).toBe("evolution");
    expect(record.name).toContain("develop 与 ts-type 融合高阶技能");
    expect(record.domain).toContain("develop & ts-type 复合工程领域");
    expect(record.description).toContain("在 mock 测试下完美融合");
    expect(record.parents).toContain("skill:develop");
    expect(record.parents).toContain("skill:ts-type");
  });

  it("triggers cognitive evolution during applySkillLearning when composite gate is met", async () => {
    const client = new GraphifyClient();

    // 运行两次成功的 applySkillLearning 来打开共现大门
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "success" });
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "success" });

    const snapshot = client.snapshot();
    
    const compositeId = composeSkillId("develop", "ts-type");
    const composite = await loadCompositeSkill(client, compositeId);
    expect(composite).toBeDefined();

    const evolutionNodes = snapshot.nodes.filter(
      (n) => n.type === "Skill" && JSON.parse(n.content).kind === "evolution"
    );
    expect(evolutionNodes.length).toBeGreaterThan(0);

    const evoRecord = JSON.parse(evolutionNodes[0]!.content);
    expect(evoRecord.parents).toContain("skill:develop");
    expect(evoRecord.parents).toContain("skill:ts-type");

    const evoId = evolutionNodes[0]!.id;
    const prereqEdges = snapshot.edges.filter(
      (e) => e.relation === "prerequisite" && e.to === evoId
    );
    expect(prereqEdges.length).toBe(2);
    
    const froms = prereqEdges.map((e) => e.from);
    expect(froms).toContain("skill:develop");
    expect(froms).toContain("skill:ts-type");
  });

  it("prioritizes and updates evolutionary skills in suggestSkillHints", async () => {
    const client = new GraphifyClient();
    
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "success" });
    await applySkillLearning(client, TASK, { status: "COMPLETED", attempts: 1, feedback: "success" });

    const hints = await suggestSkillHints(client, TASK, 5);
    
    const evolutionName = "构建 develop 与 ts-type 融合高阶技能";
    expect(hints).toContain(evolutionName);

    const evoIdx = hints.indexOf(evolutionName);
    const atomIdx = hints.indexOf("develop");
    if (atomIdx !== -1) {
      expect(evoIdx).toBeLessThan(atomIdx);
    }

    const snapshotBefore = client.snapshot();
    const evoNodeBefore = snapshotBefore.nodes.find((n) => n.id.includes("evolution:"));
    const usesBefore = evoNodeBefore ? JSON.parse(evoNodeBefore.content).uses : 0;

    await suggestSkillHints(client, TASK, 5);

    const snapshotAfter = client.snapshot();
    const evoNodeAfter = snapshotAfter.nodes.find((n) => n.id.includes("evolution:"));
    const usesAfter = evoNodeAfter ? JSON.parse(evoNodeAfter.content).uses : 0;

    expect(usesAfter).toBe(usesBefore + 1);
  });
});
