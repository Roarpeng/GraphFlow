import { describe, expect, it, vi } from "vitest";
import type { GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import {
  diversifyHitsBySourceFile,
  expandSiblingDirectoryHits,
  hasModuleFamilyIntent,
} from "../src/graph/hit-diversify";
import { rankNodesForContextQuery } from "../src/graph/graph-utils";
import { logger } from "../src/utils/logger";

vi.mock("../src/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const SLICE_NAMES = [
  "achievementSlice",
  "companionSlice",
  "dailySlice",
  "inventorySlice",
  "monsterSlice",
  "progressSlice",
  "userSlice",
] as const;

function fileNode(relPath: string, content?: string): GraphNode {
  return {
    id: `file:${relPath}`,
    type: "File",
    content: content ?? `File: ${relPath}`,
    metadata: { sourcePath: relPath, file: relPath },
  };
}

function symbolNode(relPath: string, name: string, content: string): GraphNode {
  const hash = name.slice(0, 8).padEnd(8, "0");
  return {
    id: `symbol:${relPath}:${hash}`,
    type: "Symbol",
    content,
    metadata: { sourcePath: relPath, file: relPath, name, exported: true },
  };
}

function buildStoreFamilyGraph(): {
  nodes: GraphNode[];
  hubSymbols: GraphNode[];
  sliceFiles: GraphNode[];
  noise: GraphNode;
} {
  const storePath = "web/src/store/useGameStore.ts";
  const hubSymbols = [
    symbolNode(storePath, "truncate", "function truncateStateString @useGameStore"),
    symbolNode(storePath, "customLS", "variable customLocalStorage localStorage persist"),
    symbolNode(storePath, "maxSize", "variable MAX_STORAGE_SIZE"),
    symbolNode(storePath, "GameState", "type GameState store state"),
    symbolNode(storePath, "Actions", "interface GameStateActions"),
    symbolNode(storePath, "useGame", "variable useGameStore exported zustand store"),
  ];

  const sliceFiles = SLICE_NAMES.map((name) =>
    fileNode(`web/src/store/slices/${name}.ts`, `File: ${name} slice module`)
  );
  const sliceSymbols = SLICE_NAMES.map((name) =>
    symbolNode(
      `web/src/store/slices/${name}.ts`,
      name,
      `function create${name} exported slice store`
    )
  );

  const typesFile = fileNode("web/src/store/game-types.ts");
  const noise = fileNode(
    "web/src/data/monsters.ts",
    "File: monsters ExerciseCategory boss design system"
  );
  const noiseSymbol = symbolNode(
    "web/src/data/monsters.ts",
    "Exercise",
    "type ExerciseCategory monster minion boss"
  );

  const hubFile = fileNode(storePath, "File: useGameStore main store localStorage");

  return {
    nodes: [hubFile, ...hubSymbols, typesFile, ...sliceFiles, ...sliceSymbols, noise, noiseSymbol],
    hubSymbols,
    sliceFiles,
    noise,
  };
}

function graphClient(nodes: GraphNode[], keywordHits: GraphNode[]): GraphClient {
  return {
    async upsertNodes() {
      /* test stub */
    },
    async upsertEdges() {
      /* test stub */
    },
    async queryByKeyword(query: string) {
      const q = query.toLowerCase();
      // Hub-heavy ranking: always return store symbols first (simulates pre-fix monopoly).
      if (q.includes("usegamestore") || q.includes("store") || q.includes("localstorage") || q.includes("slice")) {
        return keywordHits;
      }
      return nodes.filter((n) => n.content.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    },
    readSnapshot() {
      return { nodes, edges: [] };
    },
  };
}

describe("M79 sibling slice recall", () => {
  it("diversifyHitsBySourceFile caps symbols per file and round-robins", () => {
    const { hubSymbols, sliceFiles } = buildStoreFamilyGraph();
    const monopoly = [...hubSymbols, ...sliceFiles.flatMap(() => [])];
    // Only hub symbols — after diversify, at most 2 from useGameStore.
    const diversified = diversifyHitsBySourceFile(monopoly, { maxSymbolsPerFile: 2 });
    const fromStore = diversified.filter((n) => n.id.includes("useGameStore.ts"));
    expect(fromStore.length).toBeLessThanOrEqual(2);
    expect(diversified.length).toBe(2);
  });

  it("hasModuleFamilyIntent detects store/slice queries and store path hits", () => {
    expect(hasModuleFamilyIntent("游戏状态管理", "useGameStore slices localStorage")).toBe(true);
    expect(hasModuleFamilyIntent("random ui theme colors")).toBe(false);
    const { hubSymbols } = buildStoreFamilyGraph();
    expect(hasModuleFamilyIntent("anything", undefined, hubSymbols)).toBe(true);
  });

  it("expandSiblingDirectoryHits pulls slices File nodes after hub hits", () => {
    const { nodes, hubSymbols, sliceFiles, noise } = buildStoreFamilyGraph();
    const expanded = expandSiblingDirectoryHits(hubSymbols.slice(0, 3), nodes, {
      query: "游戏状态管理",
      englishQuery: "useGameStore store slices localStorage",
      maxSiblingFiles: 8,
    });
    const covered = sliceFiles.filter((f) => expanded.some((n) => n.id === f.id));
    expect(covered.length).toBeGreaterThanOrEqual(4);
    expect(expanded.some((n) => n.id === noise.id)).toBe(false);
  });

  it("rankNodesForContextQuery boosts /slices/ when slice intent is present", () => {
    const slice = fileNode("web/src/store/slices/dailySlice.ts");
    const data = fileNode("web/src/data/monsters.ts");
    const ranked = rankNodesForContextQuery([data, slice], "store slices", {
      scoreTokens: ["store", "slices", "daily"],
      matchQueries: ["store slices"],
    });
    expect(ranked[0]?.id).toBe(slice.id);
  });

  it("buildLayeredContextPackage covers >=4 slices and keeps monsters out of L1 top", async () => {
    const { nodes, hubSymbols, sliceFiles, noise } = buildStoreFamilyGraph();
    // Simulate monopolizing keyword hits: only hub symbols returned.
    const client = graphClient(nodes, hubSymbols);
    const { buildLayeredContextPackage } = await import("../src/graph/context-slicer");

    const pkg = await buildLayeredContextPackage(
      client,
      "游戏状态管理：useGameStore主store、各slice模块、localStorage持久化机制、状态流转",
      2000,
      {
        englishQuery:
          "useGameStore game store state management localStorage persistence slices achievement companion daily inventory monster progress user",
        enableEdgeExpansion: false,
      }
    );

    const blob = [...pkg.summaryChannel, ...pkg.anchorChannel.map((a) => a.id)].join("\n");
    const sliceHits = sliceFiles.filter((f) => blob.includes("slices/") && blob.includes(f.id.replace("file:", "")));
    // Count distinct slice file stems in anchors/summary.
    const sliceStemHits = SLICE_NAMES.filter((name) => blob.includes(name));
    expect(sliceStemHits.length).toBeGreaterThanOrEqual(4);

    const l1Anchors = pkg.anchorChannel.filter((a) => a.layer === "L1").slice(0, 8);
    expect(l1Anchors.some((a) => a.id.includes("monsters.ts") || a.id === noise.id)).toBe(false);

    // Diversify cap: at most 2 symbols from useGameStore in the whole package is ideal;
    // after sibling File inject, store symbols may still appear — cap applies before expand.
    const storeSymbolsInL1 = pkg.anchorChannel.filter(
      (a) => a.type === "Symbol" && a.id.includes("useGameStore.ts")
    );
    expect(storeSymbolsInL1.length).toBeLessThanOrEqual(2);

    expect(sliceHits.length + sliceStemHits.length).toBeGreaterThan(0);
  });
});
