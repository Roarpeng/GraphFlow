/**
 * P1 团队记忆 canary 门控：外部 sync 技能晋升 proven 前必须过 canary。
 */
import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import { importSkillPackage } from "../src/learning/skill-package";
import {
  applySkillLearning,
  classifySkillOutcome,
  extractSkillAtoms,
  markSkillCanaryValidated,
  shouldHardDeleteAntiPattern,
} from "../src/learning/skill-flywheel";
import { admitSkillToProven } from "../src/learning/skill-admission";
import { parseSkillState, serializeAtomic, skillNodeId } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";
import {
  canaryPassed,
  gateSkillPromotion,
  DEFAULT_CANARY_LOCAL_SUCCESSES,
} from "../src/learning/canary-gate";

function pickAdmissibleAtom(task: string): string {
  const atoms = extractSkillAtoms(task);
  const hit = atoms.find((atom) => admitSkillToProven(atom).ok);
  expect(hit).toBeTruthy();
  return hit!;
}

function atomicContent(partial: Partial<SkillState> & { id: string; name: string }): string {
  return serializeAtomic({
    score: 0,
    uses: 0,
    lastOutcome: "pass",
    updatedAt: Date.now(),
    ...partial,
  });
}

function skillNode(id: string, content: string) {
  return { id, type: "Skill" as const, content };
}

async function readSkill(client: GraphClient, id: string): Promise<SkillState | undefined> {
  const snapshot = client.readSnapshot?.();
  const node = snapshot?.nodes.find((n) => n.id === id && n.type === "Skill");
  return node ? parseSkillState(node.content) : undefined;
}

describe("canary-gate（团队记忆安全）", () => {
  it("外部技能 canary 未通过前保持 correctable；本地次数达标后晋升 proven", () => {
    const syncProv = { source: "sync" as const, capturedAt: "2026-01-01T00:00:00.000Z" };
    expect(canaryPassed({ provenance: syncProv, localSuccesses: 1 })).toBe(false);
    expect(
      gateSkillPromotion({
        outcomeKind: "proven",
        provenance: syncProv,
        localSuccesses: 1,
      })
    ).toBe("correctable");

    expect(
      classifySkillOutcome({
        uses: 1,
        failStreak: 0,
        linkedSuccess: true,
        provenance: syncProv,
      })
    ).toBe("correctable");

    expect(
      classifySkillOutcome({
        uses: DEFAULT_CANARY_LOCAL_SUCCESSES,
        failStreak: 0,
        linkedSuccess: false,
        provenance: syncProv,
        localSuccesses: DEFAULT_CANARY_LOCAL_SUCCESSES,
      })
    ).toBe("proven");
  });

  it("显式 validate hook 可放行外部技能晋升", () => {
    const syncProv = { source: "sync" as const };
    expect(
      classifySkillOutcome({
        uses: 1,
        failStreak: 0,
        linkedSuccess: true,
        provenance: syncProv,
        canaryValidated: true,
      })
    ).toBe("proven");
  });

  it("本地技能不受 canary 额外约束", () => {
    expect(
      classifySkillOutcome({
        uses: 2,
        failStreak: 0,
        linkedSuccess: false,
      })
    ).toBe("proven");
  });

  it("admission gate holds generic proven candidates at correctable", () => {
    expect(
      gateSkillPromotion({
        outcomeKind: "proven",
        localSuccesses: 4,
        skillName: "readme+update",
      })
    ).toBe("correctable");
    expect(
      gateSkillPromotion({
        outcomeKind: "proven",
        localSuccesses: 4,
        skillName: "skill-flywheel.ts",
      })
    ).toBe("proven");
  });

  it("sync 技能经 applySkillLearning：一次成功仍 correctable，两次后 proven", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-canary-"));
    const pkgPath = join(root, "team-skills.json");
    try {
      const task = "refactor planner module in planner.ts and add tests";
      const atom = pickAdmissibleAtom(task);
      const externalId = skillNodeId(atom);
      writeFileSync(
        pkgPath,
        JSON.stringify({
          version: "1.1",
          exportedAt: new Date().toISOString(),
          skills: [
            skillNode(
              externalId,
              atomicContent({
                id: externalId,
                name: atom,
                outcomeKind: "proven",
                uses: 99,
                hasSymbolEvidence: true,
              })
            ),
          ],
        }),
        "utf8"
      );

      const client = new GraphifyClient() as GraphClient;
      await importSkillPackage(client, pkgPath);
      const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };

      await applySkillLearning(client, task, run);
      const afterOne = await readSkill(client, externalId);
      expect(afterOne?.outcomeKind).toBe("correctable");
      expect(afterOne?.provenance?.source).toBe("sync");

      await applySkillLearning(client, task, run);
      const afterTwo = await readSkill(client, externalId);
      expect(afterTwo?.outcomeKind).toBe("proven");
      expect(afterTwo?.provenance?.source).toBe("sync");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validate hook：linked 一次成功 + markSkillCanaryValidated → proven", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-canary-validate-"));
    const pkgPath = join(root, "team-skills.json");
    try {
      const task = "refactor planner module in planner.ts and add tests";
      const atom = pickAdmissibleAtom(task);
      const externalId = skillNodeId(atom);
      writeFileSync(
        pkgPath,
        JSON.stringify({
          version: "1.1",
          exportedAt: new Date().toISOString(),
          skills: [
            skillNode(
              externalId,
              atomicContent({
                id: externalId,
                name: atom,
                hasSymbolEvidence: true,
              })
            ),
          ],
        }),
        "utf8"
      );

      const client = new GraphifyClient() as GraphClient;
      await importSkillPackage(client, pkgPath);
      await applySkillLearning(client, task, { status: "COMPLETED", attempts: 1, feedback: "ok" }, undefined, {
        linked: true,
      });
      const mid = await readSkill(client, externalId);
      expect(mid?.outcomeKind).toBe("correctable");
      expect(mid?.linkedSuccess).toBe(true);

      const validated = await markSkillCanaryValidated(client, externalId);
      expect(validated?.canaryValidated).toBe(true);
      expect(validated?.outcomeKind).toBe("proven");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("anti-pattern 隔离：不硬删除，节点仍可审计", async () => {
    expect(shouldHardDeleteAntiPattern()).toBe(false);

    const client = new GraphifyClient() as GraphClient;
    const task = "refactor planner module in planner.ts and add tests";
    const atoms = extractSkillAtoms(task);
    const id = skillNodeId(atoms[0]!);
    const fail = { status: "FAILED" as const, attempts: 1, feedback: "bad" };

    await applySkillLearning(client, task, fail);
    await applySkillLearning(client, task, fail);

    const state = await readSkill(client, id);
    expect(state?.outcomeKind).toBe("anti-pattern");
    // 节点仍在图中（隔离而非删除）
    const stillThere = client.readSnapshot?.().nodes.find((n) => n.id === id);
    expect(stillThere).toBeDefined();
    expect(stillThere?.type).toBe("Skill");
  });
});
