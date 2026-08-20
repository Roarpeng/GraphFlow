import { describe, expect, it } from "vitest";
import {
  admitSkillToProven,
  FALLBACK_GOLDEN_TOKENS,
  goldenTokenOverlap,
  isSymbolicSkillName,
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

  it("admits skill-flywheel.ts or applySkillLearning when present in golden/fallback", () => {
    const fallback = FALLBACK_GOLDEN_TOKENS.map((token) => token.toLowerCase());
    expect(
      fallback.some((token) => token.includes("skill-flywheel") || token.includes("applyskilllearning"))
    ).toBe(true);

    const flywheel = admitSkillToProven("skill-flywheel.ts");
    const fn = admitSkillToProven("applySkillLearning");
    expect(flywheel.ok).toBe(true);
    expect(fn.ok).toBe(true);
    expect(wouldDegradeLibrary("skill-flywheel.ts")).toBe(false);
    expect(goldenTokenOverlap("skill-flywheel.ts").length).toBeGreaterThan(0);
    expect(goldenTokenOverlap("applySkillLearning").length).toBeGreaterThan(0);
  });

  it("keeps names without golden overlap correctable (not proven)", () => {
    const result = admitSkillToProven("totally-unknown-widget.ts");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-golden-overlap");
    expect(isSymbolicSkillName("totally-unknown-widget.ts")).toBe(true);
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
