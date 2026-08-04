/**
 * P1-3 记忆投毒防护：外部（sync/import）技能入库门禁测试。
 *
 * 覆盖：
 *  - 外部技能合并后 provenance.source="sync" 且初始分类不为 proven
 *    （即使包内声称 proven / seeded / 携带负分历史，也一律 correctable 起步）。
 *  - 本地技能晋升路径不受影响；本地技能经 applySkillLearning 成功后可晋升 proven。
 *  - 外部技能经本地成功使用后晋升 proven，且保留 sync 来源标记。
 *  - 向后兼容：旧数据无 provenance 字段按 local 处理。
 */
import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import { importSkillPackage } from "../src/learning/skill-package";
import { applySkillLearning, extractSkillAtoms } from "../src/learning/skill-flywheel";
import { parseSkillState, serializeAtomic, skillNodeId } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";

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

describe("外部技能入库门禁（记忆投毒防护）", () => {
  it("外部技能导入后 source=sync 且分类不为 proven（即使包内声称 proven）", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-provenance-"));
    const pkgPath = join(root, "team-skills.json");
    try {
      const claimedProven = atomicContent({
        id: "skill:team-poison",
        name: "team-poison",
        score: 20,
        uses: 50,
        linkedSuccess: true,
        hasSymbolEvidence: true,
        outcomeKind: "proven",
      });
      const claimedSeeded = atomicContent({
        id: "skill:team-seeded",
        name: "team-seeded",
        seeded: true,
        outcomeKind: "proven",
        hasSymbolEvidence: true,
      });
      writeFileSync(
        pkgPath,
        JSON.stringify({
          version: "1.1",
          exportedAt: new Date().toISOString(),
          originRepo: "team/repo-x",
          skills: [skillNode("skill:team-poison", claimedProven), skillNode("skill:team-seeded", claimedSeeded)],
        }),
        "utf8"
      );

      const client = new GraphifyClient() as GraphClient;
      const result = await importSkillPackage(client, pkgPath);
      expect(result.imported).toBe(2);

      const poisoned = await readSkill(client, "skill:team-poison");
      expect(poisoned).toBeDefined();
      expect(poisoned?.provenance?.source).toBe("sync");
      expect(poisoned?.provenance?.originRepo).toBe("team/repo-x");
      expect(poisoned?.outcomeKind).not.toBe("proven");
      expect(poisoned?.outcomeKind).toBe("correctable");
      // 外部累计的使用历史/分数不得直接带入（否则可绕过晋升门禁）
      expect(poisoned?.uses).toBe(0);
      expect(poisoned?.score).toBe(0);
      expect(poisoned?.linkedSuccess).toBeFalsy();

      // seeded 豁免（直接判定 proven）同样不得随外部包传入
      const seeded = await readSkill(client, "skill:team-seeded");
      expect(seeded?.seeded).toBeFalsy();
      expect(seeded?.outcomeKind).toBe("correctable");
      expect(seeded?.provenance?.source).toBe("sync");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("旧数据无 provenance 字段按 local 处理（向后兼容）", () => {
    const legacy = parseSkillState(
      JSON.stringify({
        kind: "atomic",
        id: "skill:legacy",
        name: "legacy",
        score: 1,
        uses: 3,
        lastOutcome: "pass",
        updatedAt: 1,
      })
    );
    expect(legacy).toBeDefined();
    // 缺失 provenance 时字段保持 undefined，消费方按 local 处理
    expect(legacy?.provenance).toBeUndefined();
  });

  it("本地技能晋升路径不受影响：本地成功使用后可晋升 proven", async () => {
    const client = new GraphifyClient() as GraphClient;
    const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };
    const task = "refactor planner module in planner.ts and add tests";

    await applySkillLearning(client, task, run);
    await applySkillLearning(client, task, run);

    const atoms = extractSkillAtoms(task);
    expect(atoms.length).toBeGreaterThan(0);
    const state = await readSkill(client, skillNodeId(atoms[0]!));
    expect(state).toBeDefined();
    // 本地技能：>=2 次使用晋升 proven，且不携带 sync 来源标记
    expect(state?.outcomeKind).toBe("proven");
    expect(state?.provenance?.source ?? "local").toBe("local");
  });

  it("外部技能经本地成功使用后晋升 proven，且保留 sync 来源标记", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-provenance-promote-"));
    const pkgPath = join(root, "team-skills.json");
    try {
      const task = "refactor planner module in planner.ts and add tests";
      // 以真实提取路径确定外部技能 id（确保导入后可被本地再次学习命中）
      const atoms = extractSkillAtoms(task);
      expect(atoms.length).toBeGreaterThan(0);
      const externalId = skillNodeId(atoms[0]!);
      const external = atomicContent({
        id: externalId,
        name: atoms[0]!,
        uses: 99,
        score: 20,
        hasSymbolEvidence: true,
        outcomeKind: "proven",
      });
      writeFileSync(
        pkgPath,
        JSON.stringify({
          version: "1.1",
          exportedAt: new Date().toISOString(),
          skills: [skillNode(externalId, external)],
        }),
        "utf8"
      );

      const client = new GraphifyClient() as GraphClient;
      await importSkillPackage(client, pkgPath);
      const imported = await readSkill(client, externalId);
      expect(imported?.outcomeKind).toBe("correctable");
      expect(imported?.uses).toBe(0);

      // 本地成功使用 → 晋升 proven；来源标记保持 sync（可审计）
      const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };
      await applySkillLearning(client, task, run);
      await applySkillLearning(client, task, run);

      const promoted = await readSkill(client, externalId);
      expect(promoted?.outcomeKind).toBe("proven");
      expect(promoted?.provenance?.source).toBe("sync");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
