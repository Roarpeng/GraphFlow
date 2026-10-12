import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import {
  DEFAULT_PARALLEL_INDEX_CONCURRENCY,
  resolveIndexConcurrency,
  runIndexPipeline,
} from "../src/graph/index-pipeline";
import { getDefaultConfig } from "../src/config/defaults";

/**
 * M85 — parallel full-rebuild index pipeline.
 *
 * The pipeline overlaps file reads + parse scheduling with bounded concurrency
 * (default 4, `graphPolicy.parallelIndex`), while results merge STRICTLY in
 * walk order. These tests pin the two contracts:
 *   1. determinism — node/edge output identical at concurrency 1 vs N, and
 *      `parallelIndex.enabled: false` byte-identical to the serial run;
 *   2. failure isolation — one unreadable file logs + skips, the rest index.
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

function makeClient(storePath?: string): GraphClient {
  const config = validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      transport: storePath ? "file" : "memory",
      ...(storePath ? { graphStorePath: storePath } : {}),
      maxContextTokens: 200,
    },
    learningPolicy: {
      enableFlywheel: false,
      trainingCadence: "nightly",
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  });
  return createGraphClient(config);
}

function seedWorkspace(root: string): void {
  mkdirSync(join(root, "src-alpha"), { recursive: true });
  mkdirSync(join(root, "src-beta", "nested", "deep"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(
      join(root, "src-alpha", `alpha-${i}.ts`),
      `export function alpha${i}(x: number): number { return x + ${i}; }\nexport const ALPHA_${i} = ${i};\n`,
      "utf8"
    );
  }
  for (let i = 0; i < 8; i += 1) {
    writeFileSync(
      join(root, "src-beta", "nested", "deep", `beta-${i}.ts`),
      `import { alpha${i} } from "../../../src-alpha/alpha-${i}";\nexport function beta${i}() { return alpha${i}(1); }\n`,
      "utf8"
    );
  }
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(root, "docs", `note-${i}.md`), `# Note ${i}\n\nSome prose about topic ${i}.\n`, "utf8");
  }
  writeFileSync(join(root, "README.md"), "# Parallel pipeline fixture\n", "utf8");
}

describe("M85 parallel index pipeline", () => {
  it("resolves concurrency from the parallelIndex policy", () => {
    expect(DEFAULT_PARALLEL_INDEX_CONCURRENCY).toBe(4);
    expect(resolveIndexConcurrency()).toBe(4);
    expect(resolveIndexConcurrency({})).toBe(4);
    expect(resolveIndexConcurrency({ enabled: true })).toBe(4);
    expect(resolveIndexConcurrency({ enabled: true, concurrency: 7 })).toBe(7);
    // Legacy direct option still wins when no policy concurrency is set.
    expect(resolveIndexConcurrency(undefined, 10)).toBe(10);
    expect(resolveIndexConcurrency({}, 10)).toBe(10);
    // Disabled pins the exact serial behavior regardless of other values.
    expect(resolveIndexConcurrency({ enabled: false })).toBe(1);
    expect(resolveIndexConcurrency({ enabled: false, concurrency: 8 })).toBe(1);
    expect(resolveIndexConcurrency(undefined, 0)).toBe(1);
    expect(resolveIndexConcurrency({ enabled: true, concurrency: 0 })).toBe(1);
    expect(resolveIndexConcurrency({ enabled: true, concurrency: Number.NaN })).toBe(1);
  });

  it("exposes the documented default in graphPolicy.parallelIndex", () => {
    const config = getDefaultConfig();
    expect(config.graphPolicy.parallelIndex).toEqual({ enabled: true, concurrency: 4 });
    // Overlay configs stay partial (existing convention): an unset section is
    // absent and consumers apply the default; an explicit value passes through.
    const validated = validateConfig({
      providers: {},
      tiers: { smart: { provider: "openai", model: "gpt-4.1" }, economy: { provider: "openai", model: "gpt-4.1-mini" } },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: { transport: "memory", maxContextTokens: 100 },
      learningPolicy: { enableFlywheel: false, trainingCadence: "nightly", exportPath: "x" },
    });
    expect(validated.graphPolicy.parallelIndex).toBeUndefined();
    const optedOut = validateConfig({
      ...validated,
      graphPolicy: {
        ...validated.graphPolicy,
        parallelIndex: { enabled: false, concurrency: 2 },
      },
    });
    expect(optedOut.graphPolicy.parallelIndex).toEqual({ enabled: false, concurrency: 2 });
  });

  it("delivers pipeline results strictly in input order under concurrency", async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const delivered: number[] = [];
    // Later items resolve FIRST, so any merge-out-of-order bug would show up.
    await runIndexPipeline(
      items,
      async (item) => {
        await new Promise((resolve) => setTimeout(resolve, (29 - item) % 7));
        return item * 2;
      },
      (_item, _index, value) => {
        delivered.push(value);
      },
      { concurrency: 8 }
    );
    expect(delivered).toEqual(items.map((item) => item * 2));
  });

  it("sequential path processes one item fully before the next", async () => {
    const events: string[] = [];
    await runIndexPipeline(
      ["a", "b", "c"],
      async (item) => {
        events.push(`start:${item}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end:${item}`);
        return item;
      },
      (item, _index, _value) => {
        events.push(`merged:${item}`);
      },
      { concurrency: 1 }
    );
    expect(events).toEqual(["start:a", "end:a", "merged:a", "start:b", "end:b", "merged:b", "start:c", "end:c", "merged:c"]);
  });

  it("stops scheduling after abort but keeps results ordered", async () => {
    const controller = new AbortController();
    const items = Array.from({ length: 10 }, (_, i) => i);
    const delivered: number[] = [];
    await runIndexPipeline(
      items,
      async (item) => {
        if (item === 2) {
          controller.abort();
        }
        await new Promise((resolve) => setTimeout(resolve, 3));
        return item;
      },
      (_item, _index, value) => {
        delivered.push(value);
      },
      { concurrency: 2, signal: controller.signal }
    );
    // Delivered results are an ordered prefix; scheduling stopped early.
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(items.length);
    expect(delivered).toEqual(items.slice(0, delivered.length));
  });

  it("produces an identical graph at concurrency 1 vs 8 (determinism contract)", async () => {
    const root = makeTempDir("gf-m85-det-");
    seedWorkspace(root);

    const serialClient = makeClient();
    const parallelClient = makeClient();
    await indexWorkspaceFiles(serialClient, root, {
      includeExtensions: [".ts", ".md"],
      parallelIndex: { enabled: true, concurrency: 1 },
    });
    await indexWorkspaceFiles(parallelClient, root, {
      includeExtensions: [".ts", ".md"],
      parallelIndex: { enabled: true, concurrency: 8 },
    });

    const canonical = (client: GraphClient) => {
      const snapshot = client.readSnapshot!();
      return {
        nodes: [...snapshot.nodes]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((node) => ({ id: node.id, type: node.type, content: node.content, metadata: node.metadata })),
        edges: [...snapshot.edges]
          .sort((a, b) => `${a.from}|${a.to}|${a.relation}`.localeCompare(`${b.from}|${b.to}|${b.relation}`))
          .map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation })),
      };
    };

    expect(canonical(parallelClient)).toEqual(canonical(serialClient));
    // Directory module summaries (RAPTOR-lite) are part of the graph output and
    // must be identical across concurrency levels too.
    const summaries = canonical(serialClient).nodes.filter((node) => node.id.startsWith("module:") && node.id.endsWith("/"));
    expect(summaries.length).toBeGreaterThan(0);
  });

  it("enabled=false is byte-identical to the serial run (and to concurrency 8)", async () => {
    const readStore = (path: string): string => readFileSync(path, "utf8");
    // Fresh workspace copy per run: cache manifests must not be shared.
    const disabledRoot = makeTempDir("gf-m85-disabled-");
    seedWorkspace(disabledRoot);
    const serialRoot = makeTempDir("gf-m85-serial-");
    seedWorkspace(serialRoot);
    const parallelRoot = makeTempDir("gf-m85-parallel-");
    seedWorkspace(parallelRoot);

    const disabledStore = join(disabledRoot, "tmp", "graphflow-graph.json");
    const serialStore = join(serialRoot, "tmp", "graphflow-graph.json");
    const parallelStore = join(parallelRoot, "tmp", "graphflow-graph.json");

    await indexWorkspaceFiles(makeClient(disabledStore), disabledRoot, {
      includeExtensions: [".ts", ".md"],
      parallelIndex: { enabled: false },
    });
    await indexWorkspaceFiles(makeClient(serialStore), serialRoot, {
      includeExtensions: [".ts", ".md"],
      parallelIndex: { enabled: true, concurrency: 1 },
    });
    await indexWorkspaceFiles(makeClient(parallelStore), parallelRoot, {
      includeExtensions: [".ts", ".md"],
      parallelIndex: { enabled: true, concurrency: 8 },
    });

    const disabledBytes = readStore(disabledStore);
    const serialBytes = readStore(serialStore);
    const parallelBytes = readStore(parallelStore);
    expect(disabledBytes).toBe(serialBytes);
    expect(parallelBytes).toBe(serialBytes);
    expect(serialBytes).toContain("file:src-alpha/alpha-0.ts");
  });

  it("isolates unreadable files: logs, skips, indexes the rest", async () => {
    const root = makeTempDir("gf-m85-iso-");
    seedWorkspace(root);
    const filesToDelete = [
      ...Array.from({ length: 12 }, (_, i) => join(root, "src-alpha", `alpha-${i}.ts`)),
      ...Array.from({ length: 8 }, (_, i) => join(root, "src-beta", "nested", "deep", `beta-${i}.ts`)),
      ...Array.from({ length: 5 }, (_, i) => join(root, "docs", `note-${i}.md`)),
    ];

    const client = makeClient();
    // Serial path: after the FIRST file completes, delete every remaining file.
    // Their reads then fail (ENOENT) and must be skipped, not crash the run.
    let deleted = false;
    const result = await indexWorkspaceFiles(client, root, {
      includeExtensions: [".ts", ".md"],
      parallelIndex: { enabled: false },
      onProgress: () => {
        if (!deleted) {
          deleted = true;
          for (const path of filesToDelete) {
            try {
              unlinkSync(path);
            } catch {
              // already gone / first file still open — irrelevant
            }
          }
        }
      },
    });

    expect(result.cancelled).toBeUndefined();
    expect(result.indexedFiles).toBe(1);
    const snapshot = client.readSnapshot!();
    expect(snapshot.nodes.filter((node) => node.type === "File")).toHaveLength(1);
  });

  it("returns a cancelled partial result when the signal aborts before processing", async () => {
    const root = makeTempDir("gf-m85-abort-");
    seedWorkspace(root);
    const controller = new AbortController();
    controller.abort();
    const client = makeClient();
    const result = await indexWorkspaceFiles(client, root, {
      includeExtensions: [".ts", ".md"],
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.indexedFiles).toBe(0);
  });
});
