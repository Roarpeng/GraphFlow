import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { buildContextSlice } from "../src/graph/context-slicer";

describe("M11 workspace indexing", () => {
  it("indexes files and symbols from workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-index-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "demo.ts"),
        "export function demo() { return 1; }\nfunction hidden() { return 0; }",
        "utf8"
      );
      writeFileSync(join(root, "README.md"), "GraphFlow README", "utf8");

      const config = validateConfig({
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          enableNearLosslessMode: true,
          autoIndexOnPreview: true,
          workspaceRoot: root,
          includeExtensions: [".ts", ".md"],
          transport: "memory",
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          canaryRatio: 10,
          exportPath: "tmp/learning-dataset.jsonl",
        },
      });

      const client = createGraphClient(config);
      const indexed = await indexWorkspaceFiles(client, root, { includeExtensions: [".ts", ".md"] });
      const slice = await buildContextSlice(client, "demo", 100);

      expect(indexed.indexedFiles).toBeGreaterThanOrEqual(2);
      expect(indexed.indexedSymbols).toBeGreaterThanOrEqual(1);
      expect(slice.items.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
