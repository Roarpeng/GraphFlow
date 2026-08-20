import { describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { expandAnchor } from "../src/surfaces/cli/runtime/graph";
import { resolveConfig } from "../src/config/resolve";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Build a valid GraphFlow config JSON object for tests. */
function makeConfig(workspaceRoot: string) {
  return {
    providers: { openai: {} },
    tiers: { smart: { provider: "openai", model: "test" }, economy: { provider: "openai", model: "test" } },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      transport: "file" as const,
      graphStorePath: "graph.json",
      workspaceRoot,
      maxContextTokens: 200,
      autoIndexOnRun: false,
      autoIndexOnPreview: false,
      autoIndexOnSave: false,
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly" as const,
      canaryRatio: 10,
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  };
}

describe("M50 expand anchor on-demand context", () => {
  // ── Task 1: expandAnchor returns full node content ─────────────────
  it("should return full node content for a symbol anchor", async () => {
    const tmpDir = join(tmpdir(), `graphflow-m50-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const code = `
export function computeHash(input: string): string {
  return input + "_hashed";
}

export function processData(data: string): string {
  return computeHash(data);
}
`;
    writeFileSync(join(tmpDir, "sample.ts"), code);
    const configPath = join(tmpDir, "graphflow.config.json");
    writeFileSync(configPath, JSON.stringify(makeConfig(tmpDir)));

    try {
      const config = resolveConfig(configPath);
      const client = createGraphClient(config);
      await indexWorkspaceFiles(client, tmpDir);

      // Use the client's snapshot to find the symbol node id
      const snapshot = client.readSnapshot?.() ?? { nodes: [], edges: [] };
      const symbolNode = snapshot.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "computeHash"
      );
      expect(symbolNode).toBeDefined();

      // Expand the anchor — creates a new client from the same config/file store
      const result = await expandAnchor(symbolNode!.id, configPath);
      expect(result).toBeDefined();
      expect(result!.anchorId).toBe(symbolNode!.id);
      expect(result!.type).toBe("Symbol");
      expect(result!.content).toContain("computeHash");
      expect(result!.sourcePath).toBe("sample.ts");
      expect(result!.sourceLine).toBeDefined();
      expect(result!.sourceSnippet).toBeDefined();
      expect(result!.sourceSnippet).toContain("computeHash");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Task 2: expandAnchor returns undefined for unknown anchor ───────
  it("should return undefined for a non-existent anchor id", async () => {
    const tmpDir = join(tmpdir(), `graphflow-m50-unknown-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "dummy.ts"), "export const x = 1;\n");
    const configPath = join(tmpDir, "graphflow.config.json");
    writeFileSync(configPath, JSON.stringify(makeConfig(tmpDir)));

    try {
      const config = resolveConfig(configPath);
      const client = createGraphClient(config);
      await indexWorkspaceFiles(client, tmpDir);

      const result = await expandAnchor("symbol:nonexistent:abc123", configPath);
      expect(result).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Task 3: expandAnchor works for File nodes ──────────────────────
  it("should return file content for a File anchor", async () => {
    const tmpDir = join(tmpdir(), `graphflow-m50-file-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const code = `export const value = 42;\n`;
    writeFileSync(join(tmpDir, "constants.ts"), code);
    const configPath = join(tmpDir, "graphflow.config.json");
    writeFileSync(configPath, JSON.stringify(makeConfig(tmpDir)));

    try {
      const config = resolveConfig(configPath);
      const client = createGraphClient(config);
      await indexWorkspaceFiles(client, tmpDir);

      const snapshot = client.readSnapshot?.() ?? { nodes: [], edges: [] };
      const fileNode = snapshot.nodes.find(
        (n) => n.type === "File" && n.id === "file:constants.ts"
      );
      expect(fileNode).toBeDefined();

      const result = await expandAnchor(fileNode!.id, configPath);
      expect(result).toBeDefined();
      expect(result!.type).toBe("File");
      expect(result!.content).toContain("constants.ts");
      expect(result!.sourcePath).toBe("constants.ts");
      expect(result!.sourceSnippet).toBe(code);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return the entire File body, not a symbol-sized window", async () => {
    const tmpDir = join(tmpdir(), `graphflow-m50-fullfile-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const lines = Array.from({ length: 80 }, (_, i) => `export const line${i} = ${i};`);
    const code = `${lines.join("\n")}\n`;
    writeFileSync(join(tmpDir, "long-file.ts"), code);
    const configPath = join(tmpDir, "graphflow.config.json");
    writeFileSync(configPath, JSON.stringify(makeConfig(tmpDir)));

    try {
      const config = resolveConfig(configPath);
      const client = createGraphClient(config);
      await indexWorkspaceFiles(client, tmpDir);

      const snapshot = client.readSnapshot?.() ?? { nodes: [], edges: [] };
      const fileNode = snapshot.nodes.find(
        (n) => n.type === "File" && n.id === "file:long-file.ts"
      );
      expect(fileNode).toBeDefined();

      const result = await expandAnchor(fileNode!.id, configPath);
      expect(result).toBeDefined();
      expect(result!.sourceSnippet).toBe(code);
      expect(result!.sourceSnippet).toContain("export const line0 = 0;");
      expect(result!.sourceSnippet).toContain("export const line79 = 79;");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should respect GRAPHFLOW_EXPAND_SYMBOL_BEFORE / AFTER for Symbol windows", async () => {
    const tmpDir = join(tmpdir(), `graphflow-m50-window-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const header = Array.from({ length: 10 }, (_, i) => `const padBefore${i} = ${i};`);
    const target = "export function windowTarget(): number {\n  return 7;\n}";
    const footer = Array.from({ length: 20 }, (_, i) => `const padAfter${i} = ${i};`);
    const code = `${header.join("\n")}\n${target}\n${footer.join("\n")}\n`;
    writeFileSync(join(tmpDir, "window.ts"), code);
    const configPath = join(tmpDir, "graphflow.config.json");
    writeFileSync(configPath, JSON.stringify(makeConfig(tmpDir)));

    const prevBefore = process.env.GRAPHFLOW_EXPAND_SYMBOL_BEFORE;
    const prevAfter = process.env.GRAPHFLOW_EXPAND_SYMBOL_AFTER;
    process.env.GRAPHFLOW_EXPAND_SYMBOL_BEFORE = "1";
    process.env.GRAPHFLOW_EXPAND_SYMBOL_AFTER = "1";

    try {
      const config = resolveConfig(configPath);
      const client = createGraphClient(config);
      await indexWorkspaceFiles(client, tmpDir);

      const snapshot = client.readSnapshot?.() ?? { nodes: [], edges: [] };
      const symbolNode = snapshot.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "windowTarget"
      );
      expect(symbolNode).toBeDefined();

      const result = await expandAnchor(symbolNode!.id, configPath);
      expect(result).toBeDefined();
      expect(result!.sourceSnippet).toBeDefined();
      const snippetLines = result!.sourceSnippet!.split(/\r?\n/);
      expect(snippetLines.length).toBeLessThanOrEqual(3);
      expect(result!.sourceSnippet).toContain("windowTarget");
      expect(result!.sourceSnippet).not.toContain("padBefore0");
      expect(result!.sourceSnippet).not.toContain("padAfter19");
    } finally {
      if (prevBefore === undefined) delete process.env.GRAPHFLOW_EXPAND_SYMBOL_BEFORE;
      else process.env.GRAPHFLOW_EXPAND_SYMBOL_BEFORE = prevBefore;
      if (prevAfter === undefined) delete process.env.GRAPHFLOW_EXPAND_SYMBOL_AFTER;
      else process.env.GRAPHFLOW_EXPAND_SYMBOL_AFTER = prevAfter;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
