import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import {
  MODULE_SUMMARY_RECURSION_THRESHOLD_CHARS,
  MODULE_SUMMARY_RECURSION_THRESHOLD_CHILDREN,
  buildDirectoryModuleSummaries,
  directoryModuleNodeId,
  findStaleModuleSummaryNodeIds,
  type ModuleSummaryFileFact,
} from "../src/graph/module-summary";
import type { GraphNode } from "../src/core/types";

/**
 * M86 — recursive L2 module summaries (RAPTOR-lite).
 *
 * Directory-level Module summary nodes are generated deterministically by the
 * batch indexer. Above the recursion threshold (content size or direct-child
 * count) the detail moves DOWN to per-subdirectory child nodes and the parent
 * keeps a compact rollup. Re-indexing upserts the same ids (no duplicates);
 * directories that lose their last file are cleaned up.
 */

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function makeClient(): GraphClient {
  const config = validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: { enableAutoBuild: true, transport: "memory", maxContextTokens: 200 },
    learningPolicy: {
      enableFlywheel: false,
      trainingCadence: "nightly",
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  });
  return createGraphClient(config);
}

function tsSource(name: string, exportCount: number): string {
  const names = Array.from({ length: exportCount }, (_, i) => `export${i}`);
  return names.map((n) => `export function ${n}_${name}() { return 1; }`).join("\n") + "\n";
}

describe("M86 recursive module summaries (unit)", () => {
  it("uses deterministic directory module ids following the module: convention", () => {
    expect(directoryModuleNodeId("src/graph")).toBe("module:src/graph/");
    expect(directoryModuleNodeId("src/graph/nested")).toBe("module:src/graph/nested/");
    expect(directoryModuleNodeId(".")).toBe("module:.");
    expect(directoryModuleNodeId("")).toBe("module:.");
  });

  it("keeps a shallow module as one full-summary node", () => {
    const facts: ModuleSummaryFileFact[] = [
      { relPath: "pkg/a.ts", exports: ["alphaA", "betaA"] },
      { relPath: "pkg/b.ts", exports: ["alphaB"] },
      { relPath: "pkg/c.ts" },
    ];
    const summaries = buildDirectoryModuleSummaries(facts);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.node.id).toBe("module:pkg/");
    expect(summary.recursive).toBe(false);
    expect(summary.node.metadata).toMatchObject({ moduleSummary: true, files: 3, submodules: 0 });
    // Full detail: export names inlined, repo-map line convention.
    expect(summary.node.content).toContain("pkg/a: exports alphaA, betaA");
    expect(summary.node.content).toContain("pkg/b: exports alphaB");
    expect(summary.node.content.endsWith("pkg/c")).toBe(true); // no exports → path-only line
  });

  it("recurses when direct children exceed the children threshold (boundary 40/41)", () => {
    expect(MODULE_SUMMARY_RECURSION_THRESHOLD_CHILDREN).toBe(40);
    const atBoundary = buildDirectoryModuleSummaries(
      Array.from({ length: 40 }, (_, i) => ({ relPath: `pkg/f${i}.ts`, exports: [`e${i}`] }))
    )[0]!;
    expect(atBoundary.recursive).toBe(false);
    expect(atBoundary.node.content).toContain("exports e0");

    const overBoundary = buildDirectoryModuleSummaries(
      Array.from({ length: 41 }, (_, i) => ({ relPath: `pkg/f${i}.ts`, exports: [`e${i}`] }))
    )[0]!;
    expect(overBoundary.recursive).toBe(true);
    // Rollup: module paths kept, per-file export lists dropped.
    expect(overBoundary.node.content).toContain("pkg/f0\n");
    expect(overBoundary.node.content).not.toContain("exports e0");
  });

  it("recurses when the summary content exceeds the char threshold", () => {
    // Only 3 direct children (far below the 40-child threshold), but each
    // export line is long — the FULL summary would exceed the 4000-char
    // threshold, so the node still recurses and stores the compact rollup.
    const longName = Array.from({ length: 14 }, (_, i) => `veryLongExportNameSegment${i}`).join("");
    const exports = Array.from({ length: 30 }, (_, i) => `${longName}_${i}`);
    const fullLength = exports.slice(0, 10).join(", ").length;
    expect(fullLength * 3).toBeGreaterThan(MODULE_SUMMARY_RECURSION_THRESHOLD_CHARS);
    const summary = buildDirectoryModuleSummaries([
      { relPath: "pkg/big-a.ts", exports },
      { relPath: "pkg/big-b.ts", exports },
      { relPath: "pkg/big-c.ts", exports },
    ])[0]!;
    expect(summary.recursive).toBe(true);
    expect(summary.node.metadata).toMatchObject({ recursive: true, files: 3, submodules: 0 });
    // Rollup dropped the export detail (the size that tripped the threshold).
    expect(summary.node.content).not.toContain("veryLongExportNameSegment");
  });

  it("recursively builds the tree: parent rollup + child detail + grandchild", () => {
    const facts: ModuleSummaryFileFact[] = [
      { relPath: "root.ts", exports: ["main"] },
      ...Array.from({ length: 45 }, (_, i) => ({ relPath: `big/f${i}.ts`, exports: [`f${i}`] })),
      { relPath: "big/sub/g1.ts", exports: ["g1"] },
      { relPath: "big/sub/g2.ts", exports: ["g2"] },
    ];
    const summaries = buildDirectoryModuleSummaries(facts);
    const byId = new Map(summaries.map((s) => [s.node.id, s]));

    expect([...byId.keys()].sort()).toEqual(["module:.", "module:big/", "module:big/sub/"]);

    const root = byId.get("module:.")!;
    expect(root.recursive).toBe(false); // 1 direct file + 1 submodule → under threshold
    expect(root.node.content).toContain("root: exports main");
    expect(root.node.content).toContain("big/ (45 files");

    const big = byId.get("module:big/")!;
    expect(big.recursive).toBe(true); // 45 files + 1 submodule > 40 children
    expect(big.node.content).not.toContain("exports f0");
    expect(big.node.content).toContain("sub/ (2 files)");

    const sub = byId.get("module:big/sub/")!;
    expect(sub.recursive).toBe(false);
    expect(sub.node.content).toContain("big/sub/g1: exports g1");
    expect(sub.node.content).toContain("big/sub/g2: exports g2");
  });

  it("ignores dot-directory edge cases in ids and parents", () => {
    const summaries = buildDirectoryModuleSummaries([
      { relPath: ".github/workflows/ci.ts", exports: ["ci"] },
      { relPath: ".github/README.md" },
    ]);
    expect(summaries.map((s) => s.node.id)).toEqual(["module:.github/", "module:.github/workflows/"]);
  });

  it("detects stale summary nodes by marker without touching plain module nodes", () => {
    const snapshotNodes: GraphNode[] = [
      { id: "module:pkg/", type: "Module", content: "old", metadata: { moduleSummary: true } },
      { id: "module:pkg/gone-deep/", type: "Module", content: "old", metadata: { moduleSummary: true, files: 1 } },
      { id: "module:src/pkg", type: "Module", content: "src/pkg" }, // import target — must stay
    ];
    const stale = findStaleModuleSummaryNodeIds(snapshotNodes, new Set(["module:pkg/"]));
    expect(stale).toEqual(["module:pkg/gone-deep/"]);
  });
});

describe("M86 recursive module summaries (integration)", () => {
  function seedFixture(root: string): void {
    mkdirSync(join(root, "pkg"), { recursive: true });
    mkdirSync(join(root, "big", "sub"), { recursive: true });
    // shallow: 4 files, no subdirs → single full-summary node
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(root, "pkg", `small-${i}.ts`), tsSource(`s${i}`, 2), "utf8");
    }
    // big: 45 direct files + sub/ with 2 files → parent recurses, child full
    for (let i = 0; i < 45; i += 1) {
      writeFileSync(join(root, "big", `f${i}.ts`), tsSource(`f${i}`, 2), "utf8");
    }
    for (let i = 0; i < 2; i += 1) {
      writeFileSync(join(root, "big", "sub", `g${i}.ts`), tsSource(`g${i}`, 3), "utf8");
    }
    writeFileSync(join(root, "root.ts"), tsSource("root", 1), "utf8");
  }

  const summaryNodes = (client: GraphClient): GraphNode[] =>
    client.readSnapshot!().nodes.filter((node) => node.metadata?.moduleSummary === true);

  it("creates recursive rollup + child detail nodes, idempotently, with stale cleanup", async () => {
    const root = makeTempDir("gf-m86-");
    seedFixture(root);
    const client = makeClient();

    await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"] });

    const first = summaryNodes(client);
    const byId = new Map(first.map((node) => [node.id, node]));
    expect([...byId.keys()].sort()).toEqual(["module:.", "module:big/", "module:big/sub/", "module:pkg/"]);

    const pkg = byId.get("module:pkg/")!;
    expect(pkg.metadata).toMatchObject({ files: 4, submodules: 0 });
    expect(pkg.metadata?.recursive).toBeUndefined();
    expect(pkg.content).toContain("exports export0_s0");

    const big = byId.get("module:big/")!;
    expect(big.metadata).toMatchObject({ files: 45, submodules: 1, recursive: true });
    expect(big.content).not.toContain("exports export0_f0");
    expect(big.content).toContain("sub/ (2 files)");

    const sub = byId.get("module:big/sub/")!;
    expect(sub.metadata).toMatchObject({ files: 2, submodules: 0 });
    expect(sub.content).toContain("exports export0_g0");

    // ── Re-index (force) must not duplicate any node ────────────────────
    await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"], forceReindex: true });
    const second = summaryNodes(client);
    expect(second).toHaveLength(4);
    expect(new Set(second.map((node) => node.id)).size).toBe(4);
    expect(second.find((node) => node.id === "module:big/")?.content).toBe(big.content);

    // ── Losing a directory's last file prunes its summary node ─────────
    for (let i = 0; i < 2; i += 1) {
      unlinkSync(join(root, "big", "sub", `g${i}.ts`));
    }
    await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"] });
    const third = summaryNodes(client);
    expect(third.map((node) => node.id).sort()).toEqual(["module:.", "module:big/", "module:pkg/"]);
    const bigAfter = third.find((node) => node.id === "module:big/")!;
    expect(bigAfter.metadata).toMatchObject({ files: 45, submodules: 0, recursive: true });
  });

  it("rebuilds summaries on incremental runs from the full effective file view", async () => {
    const root = makeTempDir("gf-m86-inc-");
    seedFixture(root);
    const client = makeClient();

    await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"] });
    // Incremental change: one NEW file in pkg/ (cache warm otherwise).
    writeFileSync(join(root, "pkg", "late.ts"), tsSource("late", 2), "utf8");
    await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"] });

    const pkg = summaryNodes(client).find((node) => node.id === "module:pkg/");
    expect(pkg).toBeDefined();
    // The summary reflects the merged view (5 files), not just the 1 changed file.
    expect(pkg!.metadata).toMatchObject({ files: 5, submodules: 0 });
    expect(pkg!.content).toContain("pkg/late: exports export0_late");
    expect(pkg!.content).toContain("pkg/small-0: exports export0_s0");
  });
});
