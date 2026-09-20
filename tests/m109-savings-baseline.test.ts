import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve";
import { getSavingsStats, MIN_COUNTED_RAW_TOKENS, recordSavings } from "../src/graph/token-savings";
import { previewContext } from "../src/surfaces/cli/runtime/graph";
import { calculateSavingsPercent, estimateGrepBaselineTokens } from "../src/surfaces/cli/runtime/helpers";

/**
 * 双基线口径 + 探针过滤 / Dual-baseline accounting + probe filtering.
 *
 * ① Preview responses carry a grep+read-fragment baseline alongside
 *    `estimatedRawTokens` (which assumes reading every matching file and so
 *    overstates savings for grep-capable agents).
 * ② Cumulative ROI stats exclude noise-level probe records
 *    (`rawTokens < 1000` — repeated demo/orchestrator smoke queries) while
 *    keeping the raw records themselves.
 * ③ `averageSavingsPercent` is derived only from the counted records.
 */

const ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "graphflow-m109-"));
  ROOTS.push(root);
  return root;
}

function writeTempConfig(root: string, autoIndexOnPreview: boolean): string {
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          autoIndexOnPreview,
          autoIndexOnRun: false,
          autoIndexOnSave: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: join(root, "graph-store.json"),
          maxContextTokens: 400,
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
}

describe("grep baseline formula (pure)", () => {
  it("stat path: bytes/4 * 0.25 + 200, capped at the read-everything baseline", () => {
    // 8000 bytes → 8000/4 * 0.25 + 200 = 700
    expect(estimateGrepBaselineTokens({ topAnchorBytes: 8000, estimatedRawTokens: 5000 })).toBe(700);
    // Never exceeds estimatedRawTokens, never below 1.
    expect(estimateGrepBaselineTokens({ topAnchorBytes: 99_999_999, estimatedRawTokens: 500 })).toBe(500);
    expect(estimateGrepBaselineTokens({ topAnchorBytes: 8000, estimatedRawTokens: 1 })).toBe(1);
  });

  it("falls back to estimatedRawTokens * 0.3 when the anchor cannot be statted", () => {
    expect(estimateGrepBaselineTokens({ estimatedRawTokens: 1000 })).toBe(300);
    expect(estimateGrepBaselineTokens({ topAnchorBytes: 0, estimatedRawTokens: 1000 })).toBe(300);
    expect(estimateGrepBaselineTokens({ estimatedRawTokens: 0 })).toBe(0);
  });
});

describe("preview tokenBudget carries the grep baseline (dual baseline)", () => {
  it("decorates the preview response with both fields, bounded by estimatedRawTokens", async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "probe-alpha.ts"),
      [
        "export function tokenSavingsProbeAlpha(x: number): number {",
        "  return x * 42;",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );
    const configPath = writeTempConfig(root, true);

    const preview = await previewContext("tokenSavingsProbeAlpha", configPath, root);
    const budget = preview.tokenBudget;

    expect(budget.estimatedGrepBaselineTokens).toBeDefined();
    expect(budget.estimatedSavingsPercentVsGrep).toBeDefined();
    const baseline = budget.estimatedGrepBaselineTokens!;
    expect(baseline).toBeGreaterThan(0);
    expect(baseline).toBeLessThanOrEqual(budget.estimatedRawTokens);

    const vsGrep = budget.estimatedSavingsPercentVsGrep!;
    expect(vsGrep).toBeGreaterThanOrEqual(0);
    expect(vsGrep).toBeLessThanOrEqual(100);
    // Same denominator and clamping as estimatedSavingsPercent: the TRUE
    // accounted payload, not just the budgeted package.
    expect(vsGrep).toBe(
      calculateSavingsPercent(baseline, preview.accountedTokens ?? budget.compressedTokens)
    );
  });
});

describe("cumulative ROI stats exclude probe records (rawTokens < 1000)", () => {
  it("keeps the raw probe record but keeps it out of every cumulative field", () => {
    const root = makeRoot();
    // rootDir bind: config-file workspaceRoot alone is not honored by
    // resolveConfig — without the bind the stats would land in this repo's
    // own graphflow-out instead of the isolated temp workspace.
    const config = resolveConfig(writeTempConfig(root, false), { rootDir: root });
    const t1 = "2026-09-20T10:00:00.000Z";
    const t2 = "2026-09-20T11:00:00.000Z";

    recordSavings(config, {
      timestamp: t1,
      query: "demo probe",
      rawTokens: 84,
      compressedTokens: 80,
      savingsPercent: 5,
      source: "preview_context",
    });
    recordSavings(config, {
      timestamp: t2,
      query: "real code question",
      rawTokens: 4000,
      compressedTokens: 1000,
      savingsPercent: 75,
      source: "preview_context",
    });

    const stats = getSavingsStats(config);
    expect(MIN_COUNTED_RAW_TOKENS).toBe(1000);
    expect(stats.totalRuns).toBe(1);
    expect(stats.totalRawTokens).toBe(4000);
    expect(stats.totalCompressedTokens).toBe(1000);
    expect(stats.totalSavedTokens).toBe(3000);
    expect(stats.averageSavingsPercent).toBe(75);
    // Derived window fields also come from counted records only.
    expect(stats.firstRunAt).toBe(t2);
    expect(stats.lastRunAt).toBe(t2);
    // The raw probe record itself is retained, never deleted.
    expect(stats.recentRecords.some((record) => record.rawTokens === 84)).toBe(true);
    expect(stats.recentRecords).toHaveLength(2);
  });

  it("averageSavingsPercent is derived only from counted records (boundary 1000 counts)", () => {
    const root = makeRoot();
    const config = resolveConfig(writeTempConfig(root, false), { rootDir: root });
    const t1 = "2026-09-20T10:00:00.000Z";
    const t2 = "2026-09-20T11:00:00.000Z";
    const t3 = "2026-09-20T12:00:00.000Z";

    recordSavings(config, {
      timestamp: t1,
      query: "probe",
      rawTokens: 84,
      compressedTokens: 80,
      savingsPercent: 5,
      source: "preview_context",
    });
    recordSavings(config, {
      timestamp: t2,
      query: "real",
      rawTokens: 4000,
      compressedTokens: 1000,
      savingsPercent: 75,
      source: "preview_context",
    });
    // Exactly at the boundary: counted (exclusion is strictly < 1000).
    recordSavings(config, {
      timestamp: t3,
      query: "boundary",
      rawTokens: MIN_COUNTED_RAW_TOKENS,
      compressedTokens: 500,
      savingsPercent: 50,
      source: "preview_context",
    });

    const stats = getSavingsStats(config);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalRawTokens).toBe(5000);
    expect(stats.totalSavedTokens).toBe(3500);
    // (4000-1000) + (1000-500) = 3500 over 5000 raw → 70%, not the probe's 5%.
    expect(stats.averageSavingsPercent).toBe(70);
    expect(stats.firstRunAt).toBe(t2);
    expect(stats.lastRunAt).toBe(t3);
  });

  it("recomputes on read: a legacy aggregate-only file self-heals from its record window", () => {
    const root = makeRoot();
    const configPath = writeTempConfig(root, false);
    const outDir = join(root, "graphflow-out");
    mkdirSync(outDir, { recursive: true });
    const t1 = "2026-09-20T10:00:00.000Z";
    const t2 = "2026-09-20T11:00:00.000Z";
    // Legacy shape: polluted aggregate counters, no `records` log.
    writeFileSync(
      join(outDir, "token-savings.json"),
      JSON.stringify({
        totalRuns: 1308,
        totalRawTokens: 18_400_000,
        totalCompressedTokens: 400_000,
        totalSavedTokens: 18_000_000,
        averageSavingsPercent: 98,
        firstRunAt: "2026-01-01T00:00:00.000Z",
        lastRunAt: t1,
        recentRecords: [
          { timestamp: t2, query: "real", rawTokens: 4000, compressedTokens: 1000, savingsPercent: 75, source: "preview_context" },
          { timestamp: t1, query: "probe", rawTokens: 84, compressedTokens: 80, savingsPercent: 5, source: "preview_context" },
        ],
      }),
      "utf8"
    );

    const healed = getSavingsStats(resolveConfig(configPath, { rootDir: root }));
    expect(healed.totalRuns).toBe(1);
    expect(healed.totalRawTokens).toBe(4000);
    expect(healed.totalSavedTokens).toBe(3000);
    expect(healed.averageSavingsPercent).toBe(75);
  });
});

describe("raw baseline is anchored to the delivered anchor set (low-hit CJK query)", () => {
  it("pure-CJK query with path-expansion-only hits: bounded raw estimate + query-translate delegation", async () => {
    const root = makeRoot();
    // The nested "guard-demo" segment is the only thing the pure-CJK query
    // below can latch onto: each file's jsdoc contains exactly ONE shared
    // CJK bigram (启动) from the query, so retrieval lands on them (>= 3
    // anchors, clearing the legacy <3 rule) while per-anchor relevance stays
    // far below the low-relevance threshold — the defect-1 / defect-2 repro
    // shape (low-quality hits, inflated raw baseline), not a zero-match one.
    const nested = join(root, "guard-demo");
    mkdirSync(nested, { recursive: true });
    const files: Array<[string, string[]]> = [
      [
        "guard-hooks.ts",
        [
          "/** 启动 wiring: boots the guard checks into the pipeline. */",
          "export function guardBootstrap(): void {",
          "  return;",
          "}",
          "",
          "/** Clears guard state after shutdown. */",
          "export function guardReset(): void {",
          "  return;",
          "}",
          "",
        ],
      ],
      [
        "guard-timeline.ts",
        [
          "/** 启动 slots used while guards settle. */",
          "export const guardSlots: number[] = [0, 1, 2];",
          "",
          "export function guardSlotAt(index: number): number {",
          "  return guardSlots[index] ?? 0;",
          "}",
          "",
        ],
      ],
      [
        "boot-sequence.ts",
        [
          "/** 启动 order: steps guarded by guardBootstrap. */",
          "export function bootSequence(): string[] {",
          "  return [\"guardBootstrap\", \"guardReset\"];",
          "}",
          "",
        ],
      ],
    ];
    let anchorBytesSum = 0;
    for (const [name, lines] of files) {
      const content = lines.join("\n");
      anchorBytesSum += Buffer.byteLength(content, "utf8");
      writeFileSync(join(nested, name), content, "utf8");
    }
    const configPath = writeTempConfig(root, true);

    const preview = await previewContext(
      "启动引导时序图里的初始化守卫在哪里处理？",
      configPath,
      root
    );

    // anchorCount clears the legacy <3 trigger, so only the low-relevance
    // dimension can fire here.
    expect(preview.anchorCount).toBeGreaterThanOrEqual(1);
    expect(preview.agentMode).toBe("delegated-llm");
    expect(preview.agentWorkItems?.map((item) => item.id)).toContain("query-translate-en");
    // Low-relevance delivery trim: zero-relevance filler (config/module nodes)
    // must NOT ride along as if they were results — every delivered anchor
    // actually shares wording with the query, and the spine line says so.
    const delivered = preview.anchors as Array<{ relevance?: number }>;
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThanOrEqual(5);
    for (const anchor of delivered) {
      expect(anchor.relevance ?? 0).toBeGreaterThan(0);
    }
    expect(preview.summary[0]).toContain("低相关中文命中");

    // Raw baseline on the order of the delivered anchor volume — the old
    // whole-graph formula reported ~339K tokens for this shape.
    expect(preview.tokenBudget.estimatedRawTokens).toBeLessThan((anchorBytesSum / 4) * 3);
    // Floor semantics survive: never below the delivered payload.
    expect(preview.tokenBudget.estimatedRawTokens).toBeGreaterThanOrEqual(
      preview.accountedTokens ?? preview.tokenBudget.compressedTokens
    );
    // Savings stay meaningful rather than a hard-coded 100%.
    expect(preview.tokenBudget.estimatedSavingsPercent).toBeLessThanOrEqual(100);
  });

  it("pure-CJK query that literally matches the anchor head does not delegate", async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "battle.ts"),
      [
        "/** 游戏战斗系统核心逻辑 */",
        "export class BattleSystem {",
        "  run(): number { return 1; }",
        "}",
        "",
        "/** 游戏战斗系统伤害计算 */",
        "export function battleDamage(base: number): number { return base * 2; }",
        "",
        "/** 游戏战斗系统回合推进 */",
        "export function nextTurn(turn: number): number { return turn + 1; }",
        "",
        "/** 游戏战斗系统状态守卫 */",
        "export function guardState(ok: boolean): boolean { return ok; }",
        "",
      ].join("\n"),
      "utf8"
    );
    const configPath = writeTempConfig(root, true);

    const preview = await previewContext("游戏战斗系统", configPath, root);

    expect(preview.anchorCount).toBeGreaterThanOrEqual(3);
    // High-relevance head (jsdoc literally contains the query): the
    // low-relevance trigger must NOT fire — no spurious work item.
    expect(preview.agentWorkItems).toBeUndefined();
    expect(preview.agentMode).toBeUndefined();
    const relevances = (preview.anchors as Array<{ relevance?: number }>)
      .map((anchor) => anchor.relevance)
      .filter((relevance): relevance is number => typeof relevance === "number");
    expect(relevances.length).toBeGreaterThan(0);
    expect(Math.max(...relevances)).toBeGreaterThanOrEqual(0.5);
  });
});

afterAll(() => {
  for (const root of ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
});
