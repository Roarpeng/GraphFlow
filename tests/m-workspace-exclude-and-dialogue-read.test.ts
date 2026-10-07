import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateConfig } from "../src/config/loader";
import { isDialogueRecordNode } from "../src/graph/dialogue-node-match";
import { createGraphClient } from "../src/graph/client-factory";
import {
  getGraphifyFileStoreParseCount,
  graphifyFileStoreCache,
  graphStoreDeltaPath,
  GraphifyFileClient,
  resetGraphifyFileStoreCacheForTests,
  setGraphStoreHugeReadBytesForTests,
  writeGraphStoreFile,
} from "../src/graph/graphify-file-client";
import { readGraphStoreFileChunked } from "../src/graph/graph-store-json-chunks";
import { indexSingleFile, indexWorkspaceFiles } from "../src/graph/file-indexer";
import { walkFiles } from "../src/graph/file-indexer-walker";
import { parseIgnoreRules } from "../src/graph/workspace-ignore";
import { recordDialogueTurn } from "../src/learning/dialogue-thread";
import { GraphifySqliteClient } from "../src/graph/sqlite-client";
import type { GraphNode } from "../src/core/types";

const dirs: string[] = [];

afterEach(() => {
  setGraphStoreHugeReadBytesForTests(undefined);
  resetGraphifyFileStoreCacheForTests();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const rel = (root: string, path: string): string => relative(root, path).replace(/\\/g, "/");

function memoryClient() {
  return createGraphClient(validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: false,
      transport: "memory",
      maxContextTokens: 1500,
    },
    learningPolicy: { enableFlywheel: false, trainingCadence: "nightly", exportPath: "graphflow-out/learning-dataset.jsonl" },
  }));
}

describe("workspace exclude rules", () => {
  it("parses directory, basename, path-glob, and inline-comment rules", () => {
    const match = parseIgnoreRules([
      "# full line",
      "vendor/   # any depth",
      "tools/cache/",
      "*.secret.ts",
      "docs/**/*.md",
      "!not-supported/",
      "",
    ].join("\n"));
    expect(match).toBeTypeOf("function");
    expect(match!("nested/vendor", true)).toBe(true);
    expect(match!("nested/vendor/lib.ts", false)).toBe(true);
    expect(match!("vendor.ts", false)).toBe(false);
    expect(match!("tools/cache", true)).toBe(true);
    expect(match!("tools/cache/a.ts", false)).toBe(true);
    expect(match!("tools/other.ts", false)).toBe(false);
    expect(match!("src/a.secret.ts", false)).toBe(true);
    expect(match!("docs/a/b.md", false)).toBe(true);
    // A double-star still needs the slash the pattern wrote; `docs/readme.md`
    // is one segment under docs, so it does not match `docs/**/*.md`.
    expect(match!("docs/readme.md", false)).toBe(false);
    expect(match!("keep/file.ts", false)).toBe(false);
    // Backslash rules are normalized the same way Windows paths are.
    const win = parseIgnoreRules("tools\\cache/\n");
    expect(win!("tools/cache/a.ts", false)).toBe(true);
  });

  it("walkFiles honors .graphflowignore and excludeGlobs without dropping other files", () => {
    const root = tempDir("gf-ignore-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "skip", "vendor"), { recursive: true });
    mkdirSync(join(root, "nested", "vendor"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "a.secret.ts"), "export const s = 1;\n");
    writeFileSync(join(root, "skip", "hidden.ts"), "export const h = 1;\n");
    writeFileSync(join(root, "nested", "vendor", "x.ts"), "export const x = 1;\n");
    writeFileSync(join(root, ".graphflowignore"), "skip/ # copies\nvendor/\n");

    const found = walkFiles(root, [".ts"], { respectGitIgnore: false, excludeGlobs: ["*.secret.ts"] })
      .map((path) => rel(root, path))
      .sort();
    expect(found).toEqual(["src/app.ts"]);
  });

  it("index skips excluded files and files over maxFileSizeBytes", async () => {
    const root = tempDir("gf-index-exclude-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "skip"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "big.ts"), `export const big = "${"x".repeat(80)}";\n`);
    writeFileSync(join(root, "skip", "hidden.ts"), "export const h = 1;\n");
    writeFileSync(join(root, ".graphflowignore"), "skip/\n");

    const client = memoryClient();
    const indexed = await indexWorkspaceFiles(client, root, {
      includeExtensions: [".ts"],
      respectGitIgnore: false,
      maxFileSizeBytes: 40,
    });
    expect(indexed.indexedFiles).toBe(1);

    const single = await indexSingleFile(client, root, join(root, "skip", "hidden.ts"), {
      includeExtensions: [".ts"],
      excludeGlobs: ["skip/"],
    });
    expect(single.skipped).toBe(true);
    expect(single.reason).toMatch(/graphflowignore|excludeGlobs/);
  });

  it("validateConfig keeps excludeGlobs and maxFileSizeBytes and rejects bad values", () => {
    const config = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai" },
        economy: { provider: "openai" },
      },
      budgetPolicy: { runTokenCap: 100 },
      graphPolicy: {
        enableAutoBuild: false,
        transport: "file",
        maxContextTokens: 100,
        excludeGlobs: ["工具/", "*.jsonl"],
        maxFileSizeBytes: 50_000,
      },
      learningPolicy: { enableFlywheel: false, trainingCadence: "weekly", exportPath: "out.jsonl" },
    });
    expect(config.graphPolicy.excludeGlobs).toEqual(["工具/", "*.jsonl"]);
    expect(config.graphPolicy.maxFileSizeBytes).toBe(50_000);

    expect(() => validateConfig({
      ...config,
      graphPolicy: { ...config.graphPolicy, maxFileSizeBytes: 0 },
    })).toThrow(/maxFileSizeBytes/);
    expect(() => validateConfig({
      ...config,
      graphPolicy: { ...config.graphPolicy, excludeGlobs: [""] },
    })).toThrow(/excludeGlobs/);
  });
});

describe("dialogue record does not materialize a huge file store", () => {
  it("appends a delta and still reads the new turns back", async () => {
    const root = tempDir("gf-huge-dialogue-");
    const storePath = join(root, "graphflow-graph.json");
    const filler: GraphNode = { id: "file:big.md", type: "File", content: "x".repeat(200) };
    writeGraphStoreFile(storePath, { nodes: [filler], edges: [] });
    setGraphStoreHugeReadBytesForTests(1);
    resetGraphifyFileStoreCacheForTests();

    const client = new GraphifyFileClient(storePath);
    const first = await recordDialogueTurn(client, {
      userQuery: "where is the indexer",
      workspaceRoot: root,
      now: 1_000,
    });
    const second = await recordDialogueTurn(client, {
      userQuery: "exclude the copies",
      workspaceRoot: root,
      now: 2_000,
    });
    expect(first.recorded).toBe(true);
    expect(second.turn?.seq).toBe(2);
    expect(getGraphifyFileStoreParseCount()).toBe(0);
    expect(graphifyFileStoreCache.has(storePath)).toBe(false);

    const base = readFileSync(storePath, "utf8");
    expect(base).toContain("file:big.md");
    expect(base).not.toContain("dialogue-session");
    const delta = readFileSync(graphStoreDeltaPath(storePath), "utf8");
    expect(delta).toContain("dialogue-session");
    expect(delta).toContain("exclude the copies");

    setGraphStoreHugeReadBytesForTests(undefined);
    const snapshot = client.readSnapshot();
    expect(snapshot.nodes.some((node) => node.id === "file:big.md")).toBe(true);
    expect(snapshot.nodes.filter((node) => isDialogueRecordNode(node)).length).toBeGreaterThanOrEqual(3);
  });

  it("projects dialogue nodes out of a chunked store without keeping edges", () => {
    const root = tempDir("gf-chunk-project-");
    const storePath = join(root, "graph.json");
    writeFileSync(storePath, JSON.stringify({
      nodes: [
        { id: "file:a.ts", type: "File", content: "code" },
        { id: "dialogue:1", type: "Decision", content: "turn", metadata: { kind: "dialogue-turn" } },
      ],
      edges: [{ from: "file:a.ts", to: "dialogue:1", relation: "references" }],
    }));
    const full = readGraphStoreFileChunked(storePath);
    expect(full.nodes).toHaveLength(2);
    expect(full.edges).toHaveLength(1);
    const projected = readGraphStoreFileChunked(storePath, {
      skipEdges: true,
      keepNode: (node) => isDialogueRecordNode(node as { id: string; type: string; metadata?: { kind?: string } }),
    });
    expect(projected.edges).toEqual([]);
    expect(projected.nodes.map((node) => (node as { id: string }).id)).toEqual(["dialogue:1"]);
  });

  it("sqlite lists dialogue rows without readSnapshot", async () => {
    try {
      require("better-sqlite3");
    } catch {
      return;
    }
    const root = tempDir("gf-sql-dialogue-");
    const client = new GraphifySqliteClient(join(root, "graph.sqlite"));
    let snap: { mockRestore: () => void } | undefined;
    try {
      const nodes: GraphNode[] = [];
      for (let i = 0; i < 40; i += 1) {
        nodes.push({ id: `file:${i}.ts`, type: "File", content: "code" });
      }
      nodes.push({
        id: "dialogue:abc:0001",
        type: "Decision",
        content: "question",
        metadata: { kind: "dialogue-turn" },
      });
      await client.upsertNodes(nodes);
      snap = vi.spyOn(GraphifySqliteClient.prototype, "readSnapshot");
      const listed = await client.listDialogueNodes();
      expect(snap).not.toHaveBeenCalled();
      expect(listed.map((node) => node.id)).toEqual(["dialogue:abc:0001"]);
    } finally {
      snap?.mockRestore();
      client.close();
    }
  });
});
