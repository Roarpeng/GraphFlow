import { describe, expect, it } from "vitest";
import {
  admitSkillToProven,
  admitSkillToProvisional,
  DEFAULT_PROVEN_MIN_SUCCESS,
  isSymbolicSkillName,
  resolveProvenMinSuccess,
  wouldDegradeLibrary,
} from "../src/learning/skill-admission";

describe("wouldDegradeLibrary honours real success evidence", () => {
  it("still flags closed-set-outside names without evidence", () => {
    // 无任何证据时，闭集外名字依旧被视为会污染库（与旧行为一致）：
    expect(wouldDegradeLibrary("totally-unknown-widget.ts")).toBe(true);
  });

  it("stops flagging once the proven success threshold is met", () => {
    // 修复点：options 透传后，达到 proven 阈值的真实成功证据链不再被丢弃：
    const threshold = resolveProvenMinSuccess();
    expect(
      wouldDegradeLibrary("totally-unknown-widget.ts", { successCount: threshold })
    ).toBe(false);
    // 阈值之下（threshold - 1）仍然拒绝——fast path 只认真实达标证据：
    expect(
      wouldDegradeLibrary("totally-unknown-widget.ts", { successCount: threshold - 1 })
    ).toBe(true);
  });

  it("forwards caller-held extraGoldenTokens", () => {
    // 调用方运行时证据同样透传：叠加 golden 词后符号名不再被判为噪声：
    expect(
      wouldDegradeLibrary("totally-unknown-widget.ts", {
        extraGoldenTokens: ["totally-unknown-widget.ts"],
      })
    ).toBe(false);
  });
});

describe("admitSkillToProvisional (cold-start hint tier)", () => {
  it("admits a symbolic name with zero successes", () => {
    // 冷启动核心场景：项目符号形状的名字 0 成功也可作为提示准入：
    expect(isSymbolicSkillName("totally-unknown-widget.ts")).toBe(true);
    const symbolic = admitSkillToProvisional("totally-unknown-widget.ts");
    expect(symbolic.ok).toBe(true);
    expect(symbolic.reason).toBe("provisional-symbolic");
    // camelCase 符号形状同样准入：
    expect(admitSkillToProvisional("totallyUnknownWidget").ok).toBe(true);
  });

  it("rejects structural noise unconditionally — never usable, not even provisionally", () => {
    expect(admitSkillToProvisional("").reason).toBe("empty-name");
    expect(admitSkillToProvisional("   ").ok).toBe(false);
    expect(admitSkillToProvisional("readme+update").ok).toBe(false);
    expect(admitSkillToProvisional("readme+update").reason).toBe("stopword-only");
    expect(admitSkillToProvisional("update").reason).toBe("stopword-only");
    // readme+update 融合即使混入符号词、甚至带成功提示，也一票否决：
    const fusion = admitSkillToProvisional("readme update goal-anchor.ts", {
      successCount: 3,
    });
    expect(fusion.ok).toBe(false);
    expect(fusion.reason).toBe("readme-update-noise");
  });

  it("rejects a non-symbolic name with zero successes", () => {
    expect(isSymbolicSkillName("planner")).toBe(false);
    const bare = admitSkillToProvisional("planner");
    expect(bare.ok).toBe(false);
    expect(bare.reason).toBe("no-provisional-evidence");
  });

  it("admits a non-symbolic name with one success episode", () => {
    // 1 次真实成功即可作为提示准入（proven 仍要求默认 2 次）：
    const hinted = admitSkillToProvisional("planner", { successCount: 1 });
    expect(hinted.ok).toBe(true);
    expect(hinted.reason).toBe("provisional-success-hint");
  });
});

describe("proven thresholds unchanged (regression guard)", () => {
  it("keeps the proven gate semantics intact", () => {
    expect(DEFAULT_PROVEN_MIN_SUCCESS).toBe(2);
    expect(resolveProvenMinSuccess()).toBe(DEFAULT_PROVEN_MIN_SUCCESS);
    // 结构性噪声永远过不了 proven：
    expect(admitSkillToProven("readme+update").reason).toBe("stopword-only");
    expect(wouldDegradeLibrary("readme+update")).toBe(true);
    // golden 数据集内的项目符号照常准入：
    expect(admitSkillToProven("skill-flywheel.ts").ok).toBe(true);
    expect(wouldDegradeLibrary("skill-flywheel.ts")).toBe(false);
    // 闭集外名字：0 / 阈值-1 个成功仍拒绝，达到阈值走 success-evidence：
    expect(admitSkillToProven("totally-unknown-widget.ts").reason).toBe(
      "no-golden-overlap"
    );
    expect(
      admitSkillToProven("totally-unknown-widget.ts", { successCount: 1 }).ok
    ).toBe(false);
    const evidenced = admitSkillToProven("totally-unknown-widget.ts", {
      successCount: resolveProvenMinSuccess(),
    });
    expect(evidenced.ok).toBe(true);
    expect(evidenced.reason).toBe("success-evidence");
  });

  it("provisional is strictly weaker than proven for evidence-free names", () => {
    // provisional 准入的名字在没有成功证据时依旧过不了 proven——两层不混淆：
    expect(admitSkillToProvisional("totally-unknown-widget.ts").ok).toBe(true);
    expect(admitSkillToProven("totally-unknown-widget.ts").ok).toBe(false);
  });
});
