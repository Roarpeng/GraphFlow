import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  containsCJK,
  expandSearchQueries,
  extractPathTokens,
  nodeSearchableText,
  splitIdentifierTokens,
  tokenizeForIndex,
} from "../src/graph/graph-utils";
import { collectExpandedKeywordHits } from "../src/graph/query-expand";
import {
  buildQueryTranslateWorkItem,
  shouldDelegateQueryTranslation,
} from "../src/graph/query-translate";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";
import { buildLayeredContextPackage } from "../src/graph/context-slicer";

describe("M61 CJK query expansion", () => {
  it("detects CJK text", () => {
    expect(containsCJK("游戏战斗系统")).toBe(true);
    expect(containsCJK("battle system")).toBe(false);
    expect(containsCJK("battle战斗")).toBe(true);
  });

  it("tokenizes Chinese phrases and bigrams", () => {
    const tokens = tokenizeForIndex("游戏战斗系统");
    expect(tokens).toContain("游戏战斗系统");
    expect(tokens).toContain("游戏");
    expect(tokens).toContain("戏战");
    expect(tokens).toContain("战斗");
  });

  it("splits PascalCase and camelCase identifiers", () => {
    expect(splitIdentifierTokens("BattlePage")).toEqual(
      expect.arrayContaining(["battlepage", "battle", "page"])
    );
    expect(splitIdentifierTokens("avatarMode")).toEqual(
      expect.arrayContaining(["avatarmode", "avatar", "mode"])
    );
    expect(splitIdentifierTokens("EnergyShield")).toEqual(
      expect.arrayContaining(["energyshield", "energy", "shield"])
    );
    expect(tokenizeForIndex("src/pages/PoseDetectionPage.tsx")).toEqual(
      expect.arrayContaining(["pose", "detection", "page", "posedetectionpage"])
    );
  });

  it("matches partial english tokens against PascalCase symbols (fat-battle scenario)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-cjk-ui-"));
    const storePath = join(dir, "graph.json");
    const client = new GraphifyFileClient(storePath);

    await client.upsertNodes([
      {
        id: "file:src/pages/BattlePage.tsx",
        type: "File",
        content: "src/pages/BattlePage.tsx # exports: BattlePage",
      },
      {
        id: "symbol:src/pages/BattlePage.tsx:f138e787",
        type: "Symbol",
        content: "function BattlePage (exported) @src/pages/BattlePage.tsx:20",
        metadata: { name: "BattlePage", file: "src/pages/BattlePage.tsx" },
      },
      {
        id: "file:src/pages/PoseDetectionPage.tsx",
        type: "File",
        content: "src/pages/PoseDetectionPage.tsx # exports: PoseDetectionPage",
      },
      {
        id: "file:src/components/BattleEffects.tsx",
        type: "File",
        content:
          "src/components/BattleEffects.tsx # exports: AttackEffect, EnergyShield",
      },
      {
        id: "symbol:src/types/game.ts:7e6b65f8",
        type: "Symbol",
        content: "interface Exercise (exported) @src/types/game.ts:93",
        metadata: { name: "Exercise", file: "src/types/game.ts" },
      },
      {
        id: "file:src/data/exercises.ts",
        type: "File",
        content: "src/data/exercises.ts # exports: exercises",
      },
    ]);

    const englishQuery =
      "camera exercise avatar selection attack shield effects battle page";
    const hits = await collectExpandedKeywordHits(
      client,
      "摄像头锻炼人物角色选择和攻击护盾特效",
      join(dir, "fat-battle", "web"),
      englishQuery
    );

    const topIds = hits.slice(0, 5).map((n) => n.id);
    expect(topIds.some((id) => id.includes("BattlePage"))).toBe(true);
    expect(topIds.some((id) => id.includes("PoseDetectionPage") || id.includes("BattleEffects"))).toBe(
      true
    );
    expect(topIds[0]).not.toContain("src/data/exercises.ts");

    const pkg = await buildLayeredContextPackage(
      client,
      "摄像头锻炼人物角色选择和攻击护盾特效",
      1500,
      {
        workspaceRoot: join(dir, "fat-battle", "web"),
        englishQuery,
      }
    );
    const summary = pkg.summaryChannel.join("\n");
    expect(summary).toMatch(/BattlePage|BattleEffects|PoseDetectionPage/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts path tokens from workspace root", () => {
    const tokens = extractPathTokens("/home/user/fat-battle/web");
    expect(tokens).toContain("fat");
    expect(tokens).toContain("battle");
    expect(tokens).toContain("web");
  });

  it("expands Chinese queries with workspace path hints", () => {
    const expanded = expandSearchQueries("游戏战斗系统", "/home/user/fat-battle/web");
    expect(expanded[0]).toBe("游戏战斗系统");
    expect(expanded.some((q) => q.includes("battle"))).toBe(true);
  });

  it("matches Chinese comments indexed on symbols", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-cjk-"));
    const storePath = join(dir, "graph.json");
    const client = new GraphifyFileClient(storePath);

    await client.upsertNodes([
      {
        id: "symbol:src/combat/Battle.ts:abc",
        type: "Symbol",
        content: "class BattleSystem (exported) @src/combat/Battle.ts:10 # 游戏战斗系统核心逻辑",
        metadata: {
          jsdoc: "处理战斗伤害与回合制逻辑",
          file: "src/combat/Battle.ts",
        },
      },
      {
        id: "file:src/services/poseService.ts",
        type: "File",
        content: "src/services/poseService.ts # exports: PoseService",
      },
    ]);

    const battleHits = await client.queryByKeyword("战斗");
    expect(battleHits.some((n) => n.id.includes("Battle"))).toBe(true);

    const zhHits = await collectExpandedKeywordHits(
      client,
      "游戏战斗系统",
      join(dir, "fat-battle")
    );
    expect(zhHits.some((n) => n.id.includes("Battle"))).toBe(true);

    const pkg = await buildLayeredContextPackage(client, "游戏战斗系统", 1500, {
      workspaceRoot: join(dir, "fat-battle"),
    });
    expect(pkg.anchorChannel.length).toBeGreaterThan(0);
    expect(pkg.summaryChannel.join("\n")).toMatch(/Battle/i);

    rmSync(dir, { recursive: true, force: true });
  });

  it("nodeSearchableText includes jsdoc and paths", () => {
    const text = nodeSearchableText({
      id: "symbol:src/a.ts:1",
      type: "Symbol",
      content: "function foo @src/a.ts:1",
      metadata: { jsdoc: "中文注释", file: "src/a.ts", name: "foo" },
    });
    expect(text).toContain("中文注释");
    expect(text).toContain("src/a.ts");
  });

  it("expandSearchQueries merges agent englishQuery", () => {
    const expanded = expandSearchQueries("游戏战斗", "/tmp/fat-battle", "battle combat");
    expect(expanded).toContain("游戏战斗");
    expect(expanded).toContain("battle combat");
    expect(expanded).toContain("battle");
  });

  it("shouldDelegateQueryTranslation when CJK and low anchors", () => {
    expect(shouldDelegateQueryTranslation("战斗系统", 0)).toBe(true);
    expect(shouldDelegateQueryTranslation("战斗系统", 5)).toBe(false);
    expect(shouldDelegateQueryTranslation("battle", 0)).toBe(false);
    expect(shouldDelegateQueryTranslation("战斗", 0, "battle")).toBe(false);
  });

  it("buildQueryTranslateWorkItem includes retry instructions", () => {
    const item = buildQueryTranslateWorkItem("游戏战斗", "/home/user/fat-battle");
    expect(item.id).toBe("query-translate-en");
    expect(item.kind).toBe("query-translate");
    expect(item.prompt).toContain("englishQuery");
    expect(item.prompt).toContain("battle");
  });
});
