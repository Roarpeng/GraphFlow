import { describe, expect, it } from "vitest";
import {
  admitSkillToProven,
  goldenTokenOverlap,
  isSymbolicSkillName,
  registerGoldenEvidenceTokens,
  wouldDegradeLibrary,
} from "../src/learning/skill-admission";

function simulateHitAtK(
  library: string[],
  queryTokens: string[],
  relevant: string,
  k: number
): boolean {
  const scored = library.map((name) => {
    const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const score = queryTokens.reduce(
      (sum, token) => sum + (tokens.includes(token) || name.toLowerCase().includes(token) ? 1 : 0),
      0
    );
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, k).some((row) => row.name === relevant);
}

describe("skill admission gate", () => {
  it("rejects readme+update and generic stopword names", () => {
    expect(admitSkillToProven("readme+update").ok).toBe(false);
    expect(admitSkillToProven("readme+update").reason).toBe("stopword-only");
    expect(wouldDegradeLibrary("readme+update")).toBe(true);
    expect(admitSkillToProven("update").ok).toBe(false);
    expect(isSymbolicSkillName("readme+update")).toBe(false);
  });

  it("admits project symbols present in the repo retrieval-golden dataset", () => {
    // 词集由仓库自带检索 golden 数据集动态生成（benchmarks/datasets/retrieval-golden-v1.json），
    // 不再依赖任何硬编码闭集。skill-flywheel 是数据集 expectAny 中的符号。
    const flywheel = admitSkillToProven("skill-flywheel.ts");
    expect(flywheel.ok).toBe(true);
    expect(wouldDegradeLibrary("skill-flywheel.ts")).toBe(false);
    expect(goldenTokenOverlap("skill-flywheel.ts").length).toBeGreaterThan(0);
  });

  it("admits closed-set-outside names on real success evidence (no static list veto)", () => {
    // 无成功证据时，闭集外名字（不在任何静态/数据集列表）保持 no-golden-overlap：
    const unknown = admitSkillToProven("totally-unknown-widget.ts");
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe("no-golden-overlap");
    expect(isSymbolicSkillName("totally-unknown-widget.ts")).toBe(true);
    // 绑定 >= 阈值（默认 2）个 pass episode → 闭集外也能准入：
    const evidenced = admitSkillToProven("totally-unknown-widget.ts", { successCount: 2 });
    expect(evidenced.ok).toBe(true);
    expect(evidenced.reason).toBe("success-evidence");
    // applySkillLearning 同样不在任何静态列表中，凭成功证据链可准入：
    expect(admitSkillToProven("applySkillLearning").ok).toBe(false);
    expect(admitSkillToProven("applySkillLearning", { successCount: 2 }).ok).toBe(true);
    // 未达阈值时闭集检查仍作为辅助条件生效（1 个成功不足以免除）：
    expect(admitSkillToProven("totally-unknown-widget.ts", { successCount: 1 }).ok).toBe(false);
  });

  it("overlays real episode/symbol evidence into the dynamic golden set", () => {
    // 运行时真实证据（如 pass episode 的符号词）可叠加进动态词集：
    registerGoldenEvidenceTokens(["applySkillLearning", "total-unknown-widget.ts"]);
    expect(admitSkillToProven("applySkillLearning").ok).toBe(true);
    expect(goldenTokenOverlap("applySkillLearning").length).toBeGreaterThan(0);
  });

  it("simulates Hit@k drop when un-gated noise is injected into the library", () => {
    const relevant = "skill-flywheel.ts";
    const queryTokens = ["readme", "update", "flywheel", "skill"];
    const clean = ["skill-flywheel.ts", "planner", "goal-anchor.ts"];
    const noisy = [...clean, "readme+update"];

    expect(simulateHitAtK(clean, queryTokens, relevant, 1)).toBe(true);
    expect(simulateHitAtK(noisy, queryTokens, relevant, 1)).toBe(false);

    const gated = noisy.filter((name) => admitSkillToProven(name).ok);
    expect(gated).not.toContain("readme+update");
    expect(simulateHitAtK(gated, queryTokens, relevant, 1)).toBe(true);
  });
});
