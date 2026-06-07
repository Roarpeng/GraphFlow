import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/config/loader";
import { resolveGraphStorePath } from "../src/config/paths";
import { createGraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { rebuildGraph } from "../src/surfaces/cli/runtime";

describe("M36 graph paths and rebuild", () => {
  it("resolves graphStorePath relative to workspaceRoot, not process.cwd()", () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-paths-"));
    try {
      const config = validateConfig({
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
          graphStorePath: "tmp/graphflow-graph.json",
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: false,
          trainingCadence: "nightly",
          canaryRatio: 10,
          exportPath: "tmp/learning-dataset.jsonl",
        },
      });

      expect(resolveGraphStorePath(config)).toBe(join(root, "tmp", "graphflow-graph.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebuildGraph clears store and removes stale deleted-file nodes", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-rebuild-"));
    const configPath = join(root, "graphflow.config.json");
    const storePath = join(root, "tmp", "graphflow-graph.json");

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "keep.ts"), "export function keep() { return 1; }\n", "utf8");
      writeFileSync(join(root, "src", "drop.ts"), "export function drop() { return 0; }\n", "utf8");

      writeFileSync(
        configPath,
        JSON.stringify(
          {
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
              graphStorePath: "tmp/graphflow-graph.json",
              maxContextTokens: 200,
              semanticEnrichment: {
                enabled: false,
                mode: "off",
                autoRunOnIndex: false,
              },
            },
            learningPolicy: {
              enableFlywheel: false,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: "tmp/learning-dataset.jsonl",
            },
            routingPolicy: { enableDynamicRouting: false },
            skillPolicy: { enableSkillFlywheel: false, maxSkillHints: 0 },
          },
          null,
          2
        ),
        "utf8"
      );

      const first = await rebuildGraph(root, configPath);
      expect(first.cleared).toBe(true);
      expect(first.storePath).toBe(storePath);
      expect(existsSync(storePath)).toBe(true);

      rmSync(join(root, "src", "drop.ts"));

      const second = await rebuildGraph(root, configPath);
      const store = JSON.parse(readFileSync(storePath, "utf8")) as { nodes: Array<{ id: string }> };

      expect(second.indexedFiles).toBe(1);
      expect(store.nodes.some((node) => node.id === "file:src/keep.ts")).toBe(true);
      expect(store.nodes.some((node) => node.id === "file:src/drop.ts")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes stale symbol nodes when a file changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-prune-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "demo.ts"),
        "export function alpha() { return 1; }\nexport function beta() { return 2; }\n",
        "utf8"
      );

      const config = validateConfig({
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
          graphStorePath: join(root, "tmp", "graphflow-graph.json"),
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: false,
          trainingCadence: "nightly",
          canaryRatio: 10,
          exportPath: "tmp/learning-dataset.jsonl",
        },
      });

      const client = createGraphClient(config);
      await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"] });

      writeFileSync(join(root, "src", "demo.ts"), "export function alpha() { return 1; }\n", "utf8");
      await indexWorkspaceFiles(client, root, { includeExtensions: [".ts"] });

      const store = JSON.parse(readFileSync(join(root, "tmp", "graphflow-graph.json"), "utf8")) as {
        nodes: Array<{ id: string; content: string }>;
      };
      const betaNodes = store.nodes.filter(
        (node) => node.id.startsWith("symbol:src/demo.ts:") && node.content.includes("beta")
      );

      expect(betaNodes.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
