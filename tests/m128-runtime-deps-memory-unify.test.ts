import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GraphEdge, GraphNode } from "../src/core/types";
import { GRAPHFLOW_EMBEDDING_DTYPE_ENV, embeddingFingerprint, resolveEmbeddingDtype } from "../src/config/embedding-model";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";
import { captureMemorySubgraph, restoreMemorySubgraph } from "../src/graph/memory-subgraph";
import { GraphifySqliteClient } from "../src/graph/sqlite-client";
import {
  MERGE_MARKER_SUFFIX,
  MERGED_BACKUP_SUFFIX,
  mergeSiblingJsonStoreIntoSqlite,
  planJsonIntoSqliteMerge,
} from "../src/graph/store-migration";
import {
  adoptUnsavedSiblingPackages,
  ensureRuntimeDepsInstalled,
  inspectRuntimeDeps,
} from "../src/integrations/ensure-runtime-deps";
import { refreshStaleEmbeddings } from "../src/learning/embedding-refresh";
import {
  attachEmbedding,
  createHashEmbeddingProvider,
  createTransformersEmbeddingProvider,
  extractEmbeddingModel,
  filterCompatibleEmbeddingNodes,
  resolveTransformersCacheDir,
  type EmbeddingProvider,
} from "../src/learning/embeddings";
import { resolveOptionalDepsRoot, resolveSharedModelCacheDir, resolveSqliteDepsRoot } from "../src/utils/optional-deps";

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env[GRAPHFLOW_EMBEDDING_DTYPE_ENV];
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(node: Omit<GraphNode, "metadata">, rec: Record<string, unknown>): GraphNode {
  return { ...node, metadata: { record: JSON.stringify(rec) } };
}

function turn(hash: string, seq: number, createdAt: string, extra: Record<string, unknown> = {}): GraphNode {
  const id = `dialogue:${hash}:${String(seq).padStart(4, "0")}`;
  return record(
    { id, type: "Decision", content: `turn ${seq} @ ${createdAt}` },
    { id, seq, sessionId: `dialogue-session:${hash}`, createdAt, updatedAt: createdAt, ...extra }
  );
}

describe("M128 optional runtime deps", () => {
  it("resolves the optional-deps root and a per-ABI sqlite directory", () => {
    expect(resolveOptionalDepsRoot("/h")).toBe(join("/h", ".graphflow", "optional-deps"));
    expect(resolveSqliteDepsRoot("/r", { runtime: "electron", target: "37.0.0", abi: "136" })).toBe(
      join("/r", "sqlite-electron-abi136")
    );
  });

  it("reports missing deps when nothing is bundled or installed", () => {
    const root = tmp("gf-optdeps-");
    const deps = inspectRuntimeDeps(root, { isBundled: () => false });
    expect(deps.map((d) => [d.name, d.source])).toEqual([
      ["better-sqlite3", "missing"],
      ["@huggingface/transformers", "missing"],
    ]);
  });

  it("installs missing deps into the optional-deps root and records a marker", async () => {
    const root = tmp("gf-optdeps-");
    const calls: Array<{ dir: string; specs: string[]; env: Record<string, string> }> = [];
    const result = await ensureRuntimeDepsInstalled({
      root,
      isBundled: () => false,
      installFn: async (dir, specs, env) => {
        calls.push({ dir, specs, env });
        const modules = join(dir, "node_modules");
        mkdirSync(modules, { recursive: true });
        if (specs[0]!.startsWith("better-sqlite3")) {
          // Real binding so the ABI probe (new Database(":memory:")) passes.
          symlinkSync(resolve("node_modules/better-sqlite3"), join(modules, "better-sqlite3"), "dir");
        } else {
          const pkgDir = join(modules, "@huggingface", "transformers");
          mkdirSync(pkgDir, { recursive: true });
          writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@huggingface/transformers", version: "4.3.0", main: "index.js" }));
          writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
        }
      },
    });

    expect(result.status).toBe("installed");
    expect(calls).toHaveLength(2);
    const sqliteCall = calls.find((c) => c.specs[0]!.startsWith("better-sqlite3"))!;
    expect(sqliteCall.dir).toBe(resolveSqliteDepsRoot(root));
    expect(sqliteCall.env.npm_config_runtime).toBe("node");
    expect(result.deps.every((d) => d.source === "optional-deps" && !d.loadError)).toBe(true);

    const marker = JSON.parse(readFileSync(join(root, ".runtime-deps.json"), "utf8")) as {
      installs: Record<string, unknown>;
      lastFailure?: unknown;
    };
    expect(Object.keys(marker.installs).sort()).toEqual(
      [`@huggingface/transformers@napi`, `better-sqlite3@node-abi${process.versions.modules}`].sort()
    );
    expect(marker.lastFailure).toBeUndefined();

    const again = await ensureRuntimeDepsInstalled({ root, isBundled: () => false, installFn: async () => undefined });
    expect(again.status).toBe("already");
  });

  it("records unsaved anydoc in package.json so a saving npm install does not prune it", () => {
    const root = tmp("gf-optdeps-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "graphflow-optional-deps", private: true, version: "0.0.0" }));
    const anydoc = join(root, "node_modules", "@firecrawl", "anydoc");
    mkdirSync(anydoc, { recursive: true });
    writeFileSync(join(anydoc, "package.json"), JSON.stringify({ name: "@firecrawl/anydoc", version: "0.1.7" }));

    expect(adoptUnsavedSiblingPackages(root)).toEqual(["@firecrawl/anydoc"]);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual({ "@firecrawl/anydoc": "0.1.7" });
    expect(adoptUnsavedSiblingPackages(root)).toEqual([]);
  });

  it("records a failure and backs off background retries", async () => {
    const root = tmp("gf-optdeps-");
    const failing = async () => {
      throw new Error("network down");
    };
    const first = await ensureRuntimeDepsInstalled({ root, isBundled: () => false, installFn: failing });
    expect(first.status).toBe("failed");
    expect(first.message).toContain("network down");

    let called = false;
    const background = await ensureRuntimeDepsInstalled({
      root,
      respectBackoff: true,
      isBundled: () => false,
      installFn: async () => {
        called = true;
      },
    });
    expect(background.status).toBe("skipped");
    expect(called).toBe(false);
  });
});

describe("M128 quantized embedding model", () => {
  function fakeTransformers(calls: unknown[]) {
    return async () => ({
      env: {},
      pipeline: async (...args: unknown[]) => {
        calls.push(args);
        return async () => ({ data: new Float32Array([0.6, 0.8]) });
      },
    });
  }

  it("defaults to q8 and passes dtype to the pipeline", async () => {
    const calls: unknown[] = [];
    const provider = createTransformersEmbeddingProvider({ loadModule: fakeTransformers(calls) as never });
    expect(await provider.embed("hello")).toHaveLength(2);
    const [task, model, opts] = calls[0] as [string, string, { dtype: string; quantized: boolean }];
    expect(task).toBe("feature-extraction");
    expect(model).toBe("Xenova/bge-base-zh-v1.5");
    expect(opts).toMatchObject({ dtype: "q8", quantized: true });
    expect(provider.fingerprint?.()).toBe("Xenova/bge-base-zh-v1.5@q8");
  });

  it("caches the model in ~/.graphflow/models unless configured", () => {
    const old = process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR;
    delete process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR;
    try {
      expect(resolveTransformersCacheDir()).toBe(resolveSharedModelCacheDir());
      expect(resolveTransformersCacheDir("/cfg")).toBe("/cfg");
    } finally {
      if (old !== undefined) process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR = old;
    }
  });

  it("honours GRAPHFLOW_EMBEDDING_DTYPE over config", async () => {
    process.env[GRAPHFLOW_EMBEDDING_DTYPE_ENV] = "fp32";
    expect(resolveEmbeddingDtype("q4")).toBe("fp32");
    const calls: unknown[] = [];
    const provider = createTransformersEmbeddingProvider({ loadModule: fakeTransformers(calls) as never });
    await provider.embed("x");
    expect((calls[0] as unknown[])[2]).toMatchObject({ dtype: "fp32", quantized: false });
    expect(provider.fingerprint?.()).toBe(embeddingFingerprint("Xenova/bge-base-zh-v1.5", "fp32"));
  });
});

describe("M128 embedding fingerprints", () => {
  const bge = "Xenova/bge-base-zh-v1.5@q8";

  it("filters vectors from another model or dimension, keeping legacy unlabelled ones", () => {
    const base = (id: string): GraphNode => ({ id, type: "Symbol", content: id });
    const nodes = [
      attachEmbedding(base("a"), [1, 0, 0], bge),
      attachEmbedding(base("b"), [1, 0, 0], "fnv1a-3"),
      attachEmbedding(base("c"), [1, 0], bge),
      attachEmbedding(base("d"), [0, 1, 0]),
      base("e"),
    ];
    const { nodes: kept, skipped } = filterCompatibleEmbeddingNodes(nodes, 3, bge);
    expect(kept.map((n) => n.id)).toEqual(["a", "d"]);
    expect(skipped).toBe(2);
    expect(extractEmbeddingModel(nodes[0]!)).toBe(bge);
  });

  function seededClient(): GraphifySqliteClient {
    const client = new GraphifySqliteClient(join(tmp("gf-refresh-"), "g.sqlite"));
    return client;
  }

  it("re-embeds stale vectors with a semantic provider", async () => {
    const client = seededClient();
    const hash = createHashEmbeddingProvider(8);
    const stale = attachEmbedding({ id: "s1", type: "Symbol", content: "alpha beta" }, await hash.embed("alpha beta"), "fnv1a-8");
    const fresh = attachEmbedding({ id: "s2", type: "Symbol", content: "gamma" }, [1, 0, 0, 0], bge);
    await client.upsertNodes([stale, fresh]);

    const semantic: EmbeddingProvider = {
      fingerprint: () => bge,
      embed: async () => [0, 1, 0, 0],
    };
    const result = await refreshStaleEmbeddings(client as never, semantic);
    expect(result).toMatchObject({ stale: 1, refreshed: 1, fingerprint: bge });
    const after = client.readSnapshot().nodes.find((n) => n.id === "s1")!;
    expect(extractEmbeddingModel(after)).toBe(bge);
    client.close?.();
  });

  it("never downgrades vectors when the provider fell back to hash", async () => {
    const client = seededClient();
    const good = attachEmbedding({ id: "s1", type: "Symbol", content: "alpha" }, [1, 0, 0, 0], bge);
    await client.upsertNodes([good]);
    const result = await refreshStaleEmbeddings(client as never, createHashEmbeddingProvider(8));
    expect(result.skippedReason).toBe("hash-backend");
    expect(result.refreshed).toBe(0);
    expect(extractEmbeddingModel(client.readSnapshot().nodes[0]!)).toBe(bge);
    client.close?.();
  });
});

describe("M128 JSON → SQLite store merge", () => {
  const code: GraphNode = { id: "file:src/gone.ts", type: "File", content: "deleted file" };

  it("skips code nodes, keeps the newer side, and renumbers colliding turns", () => {
    const sqlite = {
      nodes: [
        turn("h", 1, "2026-09-01T00:00:00Z"),
        turn("h", 2, "2026-09-02T00:00:00Z", { parentTurnId: "dialogue:h:0001" }),
        record({ id: "dialogue-session:h", type: "Decision", content: "session" }, { turnCount: 2, tipTurnId: "dialogue:h:0002", updatedAt: "2026-09-02T00:00:00Z" }),
        record({ id: "skill:x", type: "Skill", content: "old" }, { updatedAt: "2026-09-01T00:00:00Z" }),
        record({ id: "skill:y", type: "Skill", content: "sqlite-newer" }, { updatedAt: "2026-09-05T00:00:00Z" }),
      ],
      edges: [] as GraphEdge[],
    };
    const json = {
      nodes: [
        turn("h", 1, "2026-09-01T00:00:00Z"),
        turn("h", 2, "2026-09-03T00:00:00Z", { parentTurnId: "dialogue:h:0001" }),
        turn("h", 3, "2026-09-04T00:00:00Z", { parentTurnId: "dialogue:h:0002" }),
        record({ id: "skill:x", type: "Skill", content: "json-newer" }, { updatedAt: "2026-09-06T00:00:00Z" }),
        record({ id: "skill:y", type: "Skill", content: "json-older" }, { updatedAt: "2026-09-01T00:00:00Z" }),
        record({ id: "episode:1", type: "Decision", content: "only in json" }, { createdAt: "2026-09-01T00:00:00Z" }),
        code,
      ],
      edges: [
        { from: "dialogue:h:0002", to: "dialogue:h:0003", relation: "next_section" },
        { from: "episode:1", to: "file:src/gone.ts", relation: "changes" },
      ] as GraphEdge[],
    };

    const plan = planJsonIntoSqliteMerge(sqlite, json);
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));

    expect(plan.stats.skippedCodeNodes).toBe(1);
    expect(byId.has("file:src/gone.ts")).toBe(false);
    expect(byId.get("skill:x")?.content).toBe("json-newer");
    expect(byId.has("skill:y")).toBe(false);
    expect(byId.has("episode:1")).toBe(true);

    // JSON turn 2 collided with a different SQLite turn 2 → renumbered to 4;
    // JSON turn 3 had no collision but its parent (JSON turn 2) moved.
    expect(plan.stats.renumberedTurns).toBe(1);
    expect(byId.get("dialogue:h:0002")).toBeUndefined();
    const moved = JSON.parse(String(byId.get("dialogue:h:0004")!.metadata!.record)) as Record<string, unknown>;
    expect(moved.createdAt).toBe("2026-09-03T00:00:00Z");
    const third = JSON.parse(String(byId.get("dialogue:h:0003")!.metadata!.record)) as Record<string, unknown>;
    expect(third.parentTurnId).toBe("dialogue:h:0004");
    const session = JSON.parse(String(byId.get("dialogue-session:h")!.metadata!.record)) as Record<string, unknown>;
    expect(session.turnCount).toBe(4);
    expect(session.tipTurnId).toBe("dialogue:h:0003");

    expect(plan.edges).toEqual([{ from: "dialogue:h:0004", to: "dialogue:h:0003", relation: "next_section" }]);
    expect(plan.stats.droppedEdges).toBe(1);
  });

  it("merges a sibling JSON store once, backs it up, and clears the index manifest only the first time", async () => {
    const root = tmp("gf-merge-");
    const out = join(root, "graphflow-out");
    const sqlitePath = join(out, "graphflow-graph.sqlite");
    const jsonPath = join(out, "graphflow-graph.json");
    const manifest = join(root, ".graphflow-cache", "index-state.json");
    mkdirSync(join(root, ".graphflow-cache"), { recursive: true });

    const writeJson = async (nodes: GraphNode[]) => {
      const file = new GraphifyFileClient(jsonPath);
      await file.upsertNodes(nodes);
      await file.close?.();
    };
    await writeJson([record({ id: "episode:a", type: "Decision", content: "a" }, { createdAt: "2026-09-01T00:00:00Z" }), code]);
    writeFileSync(manifest, "{}");

    const sqlite = new GraphifySqliteClient(sqlitePath);
    const stats = mergeSiblingJsonStoreIntoSqlite(sqlite, sqlitePath, { workspaceRoot: root });
    expect(stats).toMatchObject({ addedNodes: 1, skippedCodeNodes: 1 });
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(`${jsonPath}${MERGED_BACKUP_SUFFIX}`)).toBe(true);
    expect(existsSync(`${sqlitePath}${MERGE_MARKER_SUFFIX}`)).toBe(true);
    expect(existsSync(manifest)).toBe(false);
    expect(sqlite.readSnapshot().nodes.map((n) => n.id)).toEqual(["episode:a"]);

    // No JSON sibling → no-op.
    expect(mergeSiblingJsonStoreIntoSqlite(sqlite, sqlitePath, { workspaceRoot: root })).toBeUndefined();

    // A not-yet-upgraded host writes JSON again: merged, but the manifest survives.
    writeFileSync(manifest, "{}");
    await writeJson([record({ id: "episode:b", type: "Decision", content: "b" }, { createdAt: "2026-09-02T00:00:00Z" })]);
    const second = mergeSiblingJsonStoreIntoSqlite(sqlite, sqlitePath, { workspaceRoot: root });
    expect(second?.addedNodes).toBe(1);
    expect(existsSync(manifest)).toBe(true);
    expect(sqlite.readSnapshot().nodes.map((n) => n.id).sort()).toEqual(["episode:a", "episode:b"]);

    // Backups: the first one is kept, later merges rotate one `.latest` copy.
    await writeJson([record({ id: "episode:c", type: "Decision", content: "c" }, { createdAt: "2026-09-03T00:00:00Z" })]);
    mergeSiblingJsonStoreIntoSqlite(sqlite, sqlitePath, { workspaceRoot: root });
    const backups = readdirSync(out).filter((f) => f.startsWith("graphflow-graph.json") && f.includes(MERGED_BACKUP_SUFFIX));
    expect(backups.filter((f) => !f.includes(".delta")).sort()).toEqual([
      `graphflow-graph.json${MERGED_BACKUP_SUFFIX}`,
      `graphflow-graph.json${MERGED_BACKUP_SUFFIX}.latest`,
    ]);
    sqlite.close?.();
  });
});

describe("M128 rebuild keeps memory", () => {
  it("captures memory nodes and restores them without edges to vanished code", async () => {
    const root = tmp("gf-memory-");
    const before = new GraphifySqliteClient(join(root, "a.sqlite"));
    await before.upsertNodes([
      { id: "file:src/keep.ts", type: "File", content: "keep" },
      { id: "file:src/drop.ts", type: "File", content: "drop" },
      record({ id: "episode:1", type: "Decision", content: "memory" }, { createdAt: "2026-09-01T00:00:00Z" }),
    ]);
    await before.upsertEdges([
      { from: "episode:1", to: "file:src/keep.ts", relation: "changes" },
      { from: "episode:1", to: "file:src/drop.ts", relation: "changes" },
      { from: "file:src/keep.ts", to: "file:src/drop.ts", relation: "imports" },
    ]);
    const memory = captureMemorySubgraph(before.readSnapshot());
    before.close?.();
    expect(memory.nodes.map((n) => n.id)).toEqual(["episode:1"]);
    expect(memory.edges).toHaveLength(2);

    const after = new GraphifySqliteClient(join(root, "b.sqlite"));
    await after.upsertNodes([{ id: "file:src/keep.ts", type: "File", content: "keep" }]);
    const restored = await restoreMemorySubgraph(after as never, memory);
    expect(restored).toEqual({ nodes: 1, edges: 1, droppedEdges: 1 });
    const snap = after.readSnapshot();
    expect(snap.nodes.some((n) => n.id === "episode:1")).toBe(true);
    expect(snap.edges).toEqual([{ from: "episode:1", to: "file:src/keep.ts", relation: "changes" }]);
    after.close?.();
  });

  it("rebuildGraph --full keeps dialogue memory in the store", async () => {
    const root = tmp("gf-rebuild-memory-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "keep.ts"), "export function keep() { return 1; }\n", "utf8");
    const configPath = join(root, "graphflow.config.json");
    const storePath = join(root, "graphflow-out", "graphflow-graph.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-4.1" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          enableNearLosslessMode: true,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: "graphflow-out/graphflow-graph.json",
          maxContextTokens: 200,
          semanticEnrichment: { enabled: false, mode: "off", autoRunOnIndex: false },
        },
        learningPolicy: {
          enableFlywheel: false,
          trainingCadence: "nightly",
          canaryRatio: 10,
          exportPath: "graphflow-out/learning-dataset.jsonl",
        },
        routingPolicy: { enableDynamicRouting: false },
        skillPolicy: { enableSkillFlywheel: false, maxSkillHints: 0 },
      }),
      "utf8"
    );

    const { rebuildGraph } = await import("../src/surfaces/cli/runtime");
    await rebuildGraph(root, configPath);
    const store = new GraphifyFileClient(storePath);
    await store.upsertNodes([turn("h", 1, "2026-09-01T00:00:00Z")]);
    await store.upsertEdges([{ from: "dialogue:h:0001", to: "file:src/keep.ts", relation: "references" }]);
    await store.close?.();

    const result = await rebuildGraph(root, configPath);
    expect(result.preservedMemory?.nodes).toBe(1);
    const snap = new GraphifyFileClient(storePath).readSnapshot();
    expect(snap.nodes.some((n) => n.id === "dialogue:h:0001")).toBe(true);
    expect(snap.nodes.some((n) => n.id === "file:src/keep.ts")).toBe(true);
    expect(snap.edges).toContainEqual({ from: "dialogue:h:0001", to: "file:src/keep.ts", relation: "references" });
  });
});
