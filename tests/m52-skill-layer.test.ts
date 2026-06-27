import { describe, expect, it } from "vitest";
import { graphflowSkills, listSkills, invokeSkill, type GraphFlowSkillName } from "../src/skills";

describe("M52 GraphFlow Skills Layer", () => {
  it("exports all 7 core skills", () => {
    const skills = listSkills();
    expect(skills.length).toBe(7);
    expect(skills.map((s) => s.name)).toEqual([
      "graphflow.compress",
      "graphflow.plan",
      "graphflow.planInsight",
      "graphflow.index",
      "graphflow.inspect",
      "graphflow.expandAnchor",
      "graphflow.run",
    ]);
  });

  it("each skill has name, description, version, invoke", () => {
    for (const skill of Object.values(graphflowSkills)) {
      expect(skill.name).toBeDefined();
      expect(skill.description).toBeDefined();
      expect(skill.version).toBe("1.0.0");
      expect(typeof skill.invoke).toBe("function");
    }
  });

  it("invokeSkill throws on unknown skill", async () => {
    await expect(
      invokeSkill("nonexistent" as GraphFlowSkillName, {} as never)
    ).rejects.toThrow("Unknown skill");
  });

  it("graphflow.index skill returns proper structure", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(join(tmpdir(), "graphflow-skill-test-"));
    writeFileSync(join(tmpDir, "hello.ts"), "export function hello() { return 1; }\n", "utf8");

    const result = await graphflowSkills["graphflow.index"].invoke({
      rootDir: tmpDir,
    });
    expect(result.success).toBe(true);
    expect(typeof result.indexedFiles).toBe("number");
    expect(typeof result.indexedSymbols).toBe("number");
    expect(typeof result.indexedReferences).toBe("number");
    expect(result.indexedFiles).toBeGreaterThan(0);
  }, 30000);

  it("graphflow.inspect skill returns proper structure", async () => {
    const result = await graphflowSkills["graphflow.inspect"].invoke({
      rootDir: process.cwd(),
    });
    expect(result.success).toBe(true);
    expect(typeof result.nodeCount).toBe("number");
    expect(typeof result.edgeCount).toBe("number");
    expect(Array.isArray(result.topRelations)).toBe(true);
    expect(Array.isArray(result.sampleNodes)).toBe(true);
  });

  it("graphflow.compress skill returns token budget", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(join(tmpdir(), "graphflow-skill-compress-"));
    writeFileSync(join(tmpDir, "hello.ts"), "export function hello() { return 1; }\n", "utf8");

    await graphflowSkills["graphflow.index"].invoke({ rootDir: tmpDir });

    const result = await graphflowSkills["graphflow.compress"].invoke({
      query: "hello function",
      rootDir: tmpDir,
    });
    expect(result.success).toBe(true);
    expect(Array.isArray(result.compressed)).toBe(true);
    expect(Array.isArray(result.anchors)).toBe(true);
    expect(result.tokenBudget.maxContextTokens).toBeGreaterThan(0);
    expect(typeof result.tokenBudget.estimatedSavingsPercent).toBe("number");
  }, 30000);

  it("graphflow.expandAnchor handles missing anchor gracefully", async () => {
    const result = await graphflowSkills["graphflow.expandAnchor"].invoke({
      anchorId: "nonexistent-anchor-id-12345",
      rootDir: process.cwd(),
    });
    expect(result.success).toBe(false);
    expect(result.anchorId).toBe("nonexistent-anchor-id-12345");
  });
});
