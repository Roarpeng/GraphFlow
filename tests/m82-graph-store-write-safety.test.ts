import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import {
  readGraphStoreFileChunked,
  readGraphStoreFromChunks,
} from "../src/graph/graph-store-json-chunks";
import { writeGraphStoreFile } from "../src/graph/graphify-file-client";
import type { GraphEdge, GraphNode } from "../src/core/types";
import { readFileGraphStore } from "../src/surfaces/cli/runtime/helpers";
import { inspectGraph } from "../src/surfaces/cli/runtime/graph";
import { getSettingsPanelStatus } from "../src/surfaces/cli/runtime/panel";

/**
 * M82 — "GraphFlow MCP 自动安装失败: Invalid string length" (VS Code extension).
 *
 * The extension's MCP auto-install calls `getSettingsPanelStatus()`; that used to
 * auto-index the workspace through `inspectGraph`, and the file transport wrote
 * the whole graph as ONE pretty-printed JSON string. On a docs-heavy repo the
 * indexer legitimately produces millions of `references` edges, so the payload
 * crossed V8's maximum string length (~512 MB) and `JSON.stringify` threw
 * `RangeError: Invalid string length` — surfaced to the user as a failed install.
 *
 * Two independent guarantees are pinned here:
 * 1. the panel/status path is read-only (it never indexes);
 * 2. the store writer never materializes one giant string and reports oversized
 *    stores with an actionable message instead of a bare RangeError.
 */

const tempRoots: string[] = [];
let previousEnvRoot: string | undefined;

function makeWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeConfig(workspace: string): string {
  const configPath = join(workspace, "graphflow.config.json");
  const defaults = getDefaultConfig();
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...defaults,
        graphPolicy: {
          ...defaults.graphPolicy,
          transport: "file",
          graphStorePath: "graphflow-out/graphflow-graph.json",
          includeExtensions: [".ts"],
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return configPath;
}

function writeSourceFile(workspace: string): void {
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "sample.ts"),
    [
      "export interface Widget { id: string; size: number }",
      "export function buildWidget(id: string): Widget {",
      "  return { id, size: id.length };",
      "}",
      "export class WidgetFactory {",
      "  create(id: string): Widget { return buildWidget(id); }",
      "}",
    ].join("\n"),
    "utf8"
  );
}

beforeEach(() => {
  previousEnvRoot = process.env.GRAPHFLOW_WORKSPACE_ROOT;
});

afterEach(() => {
  if (previousEnvRoot === undefined) delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
  else process.env.GRAPHFLOW_WORKSPACE_ROOT = previousEnvRoot;
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("M82 graph store write safety", () => {
  it("keeps the settings panel status read-only (no indexing, no store write)", async () => {
    const workspace = makeWorkspace("gf-m82-panel-");
    const configPath = writeConfig(workspace);
    writeSourceFile(workspace);
    process.env.GRAPHFLOW_WORKSPACE_ROOT = workspace;
    const storePath = join(workspace, "graphflow-out", "graphflow-graph.json");

    const status = await getSettingsPanelStatus(configPath);

    expect(status.graphNodeCount).toBe(0);
    expect(status.graphEdgeCount).toBe(0);
    expect(existsSync(storePath)).toBe(false);
  });

  it("keeps inspectGraph indexing by default (CLI behaviour unchanged)", async () => {
    const workspace = makeWorkspace("gf-m82-inspect-");
    const configPath = writeConfig(workspace);
    writeSourceFile(workspace);
    const storePath = join(workspace, "graphflow-out", "graphflow-graph.json");

    const snapshot = await inspectGraph(configPath, {
      nodeLimit: 1,
      edgeLimit: 1,
      rootDir: workspace,
    });

    expect(snapshot.nodeCount).toBeGreaterThan(0);
    expect(existsSync(storePath)).toBe(true);
  });

  it("honours autoIndex: false without touching the store", async () => {
    const workspace = makeWorkspace("gf-m82-noindex-");
    const configPath = writeConfig(workspace);
    writeSourceFile(workspace);

    const snapshot = await inspectGraph(configPath, {
      nodeLimit: 1,
      edgeLimit: 1,
      rootDir: workspace,
      autoIndex: false,
    });

    expect(snapshot.nodeCount).toBe(0);
    expect(existsSync(join(workspace, "graphflow-out", "graphflow-graph.json"))).toBe(false);
  });

  it("writes small stores pretty-printed and large stores compact + chunked", () => {
    const workspace = makeWorkspace("gf-m82-write-");
    const nodes: GraphNode[] = [
      { id: "file:src/a.ts", type: "File", content: "a" },
      { id: "symbol:src/a.ts:abc", type: "Symbol", content: "a" },
    ];
    const edges: GraphEdge[] = [
      { from: "file:src/a.ts", to: "symbol:src/a.ts:abc", relation: "references" },
    ];
    const store = { nodes, edges };

    const prettyPath = join(workspace, "pretty.json");
    writeGraphStoreFile(prettyPath, store);
    const pretty = readFileSync(prettyPath, "utf8");
    expect(pretty).toContain('\n  "nodes"');
    expect(JSON.parse(pretty)).toEqual(store);

    // Force the streaming/compact path (the branch a multi-million-edge graph takes).
    const compactPath = join(workspace, "compact.json");
    writeGraphStoreFile(compactPath, store, { prettyPrintMaxElements: 0, chunkBytes: 1 });
    const compact = readFileSync(compactPath, "utf8");
    expect(compact).not.toContain('\n  "nodes"');
    expect(compact.length).toBeLessThan(pretty.length);
    expect(JSON.parse(compact)).toEqual(store);
  });

  it("routes oversized stores through the chunked parser instead of failing", () => {
    const workspace = makeWorkspace("gf-m82-oversized-");
    const storeDir = join(workspace, "graphflow-out");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "graphflow-graph.json");
    const store = {
      nodes: [{ id: "file:src/a.ts", type: "File", content: 'quote " and 换行\n newline' }],
      edges: [{ from: "file:src/a.ts", to: "file:src/a.ts", relation: "references" }],
    };
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    const size = statSync(storePath).size;

    // Above the (injected) single-string limit the reader must parse in chunks
    // rather than let readFileSync throw ERR_STRING_TOO_LONG.
    const parsed = readFileGraphStore(storePath, { singleStringLimitBytes: size - 1 });

    expect(parsed.nodes).toEqual(store.nodes);
    expect(parsed.edges).toEqual(store.edges);
  });

  it("parses stores identically across arbitrary chunk boundaries", () => {
    const store = {
      nodes: [
        { id: "file:src/a.ts", type: "File", content: '{"nested":[1,2,{"deep":"v"}]}' },
        { id: "symbol:src/a.ts:abc", type: "Symbol", metadata: { text: 'a,b]}c"d', n: 1.5e-7 } },
      ],
      edges: [{ from: "file:src/a.ts", to: "symbol:src/a.ts:abc", relation: "references" }],
    };
    const document = `${JSON.stringify(store, null, 2)}\n`;
    const chunks = (text: string, length: number) => {
      let offset = 0;
      return () => (offset >= text.length ? null : text.slice(offset, (offset += length)));
    };

    expect(readGraphStoreFromChunks(chunks(document, document.length))).toEqual(store);
    expect(readGraphStoreFromChunks(chunks(document, 1))).toEqual(store);
    expect(readGraphStoreFromChunks(chunks(document, 3))).toEqual(store);
    expect(readGraphStoreFromChunks(chunks(document, 7))).toEqual(store);

    // Multi-byte characters split across chunk boundaries must survive.
    const unicodeFile = join(makeWorkspace("gf-m82-unicode-"), "store.json");
    const unicodeStore = { nodes: [{ id: "file:文档.md", type: "File", content: "中文内容 🚀" }], edges: [] };
    writeGraphStoreFile(unicodeFile, unicodeStore, { prettyPrintMaxElements: 0, chunkBytes: 1 });
    expect(readGraphStoreFileChunked(unicodeFile, { chunkBytes: 64 * 1024 })).toEqual(unicodeStore);

    // A truncated document is rejected rather than silently half-read.
    expect(() => readGraphStoreFromChunks(chunks(document.slice(0, -5), 3))).toThrow(/truncated/i);
  });
});
