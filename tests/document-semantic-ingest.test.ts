import { describe, expect, it } from "vitest";
import {
  buildDocumentSemanticGraphFragment,
  parseDocumentSemanticPayload,
  resolveCodeHintTargets,
} from "../src/graph/document-semantic-ingest";
import type { GraphNode } from "../src/core/types";
import { submitAgentInsight } from "../src/core/submit-agent-insight";
import { createGraphClient } from "../src/graph/client-factory";
import { validateConfig } from "../src/config/loader";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("document semantic ingest (cross-layer KG)", () => {
  it("parses payload and builds Concept/Requirement with documents/implements/derived_from", () => {
    const existing: GraphNode[] = [
      {
        id: "file:docs/api.pdf",
        type: "File",
        content: "api.pdf",
        metadata: { language: "document" },
      },
      {
        id: "file:src/index.ts",
        type: "File",
        content: "index.ts",
      },
      {
        id: "symbol:src/index.ts:abc",
        type: "Symbol",
        content: "function indexGraph",
        metadata: { name: "indexGraph", file: "src/index.ts", kind: "function" },
      },
    ];

    const payload = parseDocumentSemanticPayload({
      relPath: "docs/api.pdf",
      title: "API Spec",
      summary: "Defines indexing API.",
      keyEntities: ["GraphIndex", "MCP"],
      requirements: ["Must support incremental index"],
      relatedCodeHints: ["indexGraph", "src/index.ts"],
      tags: ["api"],
    });

    const fragment = buildDocumentSemanticGraphFragment(payload, {
      insightNodeId: "decision:agent-insight:test",
      existingNodes: existing,
    });

    expect(fragment.nodes.some((n) => n.type === "Concept")).toBe(true);
    expect(fragment.nodes.some((n) => n.type === "Requirement")).toBe(true);
    expect(fragment.edges.some((e) => e.relation === "documents")).toBe(true);
    expect(fragment.edges.some((e) => e.relation === "derived_from")).toBe(true);
    expect(fragment.edges.some((e) => e.relation === "implements")).toBe(true);
    expect(fragment.linkedCodeNodeIds.length).toBeGreaterThan(0);
  });

  it("resolveCodeHintTargets matches file paths and symbol names", () => {
    const nodes: GraphNode[] = [
      { id: "file:src/foo.ts", type: "File", content: "foo" },
      {
        id: "symbol:src/foo.ts:1",
        type: "Symbol",
        content: "function bar",
        metadata: { name: "bar" },
      },
    ];
    expect(resolveCodeHintTargets(["src/foo.ts", "bar"], nodes)).toEqual(
      expect.arrayContaining(["file:src/foo.ts", "symbol:src/foo.ts:1"])
    );
  });

  it("submitAgentInsight document-semantic upserts doc-domain nodes", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-doc-sem-"));
    try {
      const config = validateConfig({
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: false,
          enableNearLosslessMode: true,
          autoIndexOnPreview: false,
          workspaceRoot: root,
          transport: "memory",
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: false,
          trainingCadence: "nightly",
          canaryRatio: 10,
          exportPath: "graphflow-out/learning-dataset.jsonl",
        },
      });
      const client = createGraphClient(config);
      await client.upsertNodes([
        { id: "file:docs/spec.pdf", type: "File", content: "spec" },
        {
          id: "symbol:src/a.ts:1",
          type: "Symbol",
          content: "function convert",
          metadata: { name: "convert" },
        },
      ]);

      const result = await submitAgentInsight(client, {
        task: "index docs",
        workItemId: "document-semantic-1",
        episodeId: "episode:doc-sem-1",
        response: JSON.stringify({
          relPath: "docs/spec.pdf",
          title: "Spec",
          summary: "Conversion rules.",
          keyEntities: ["AnyDoc"],
          requirements: ["Convert PDF to Markdown"],
          relatedCodeHints: ["convert"],
        }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.documentGraph?.requirementIds.length).toBeGreaterThan(0);
      expect(result.documentGraph?.conceptIds.length).toBeGreaterThan(0);
      expect(result.documentGraph?.edgeCount).toBeGreaterThan(0);
      expect(result.engineeringLinks?.edgeCount).toBeGreaterThan(0);

      const snapshot = client.readSnapshot!();
      expect(snapshot.nodes.some((n) => n.type === "Requirement")).toBe(true);
      expect(snapshot.edges.some((e) => e.relation === "documents")).toBe(true);
      expect(snapshot.edges.some((e) => e.relation === "implements")).toBe(true);
      expect(
        snapshot.edges.some(
          (e) =>
            e.from === "episode:doc-sem-1" &&
            e.relation === "derived_from" &&
            (result.documentGraph?.requirementIds.includes(e.to) ||
              result.documentGraph?.conceptIds.includes(e.to) ||
              result.documentGraph?.linkedCodeNodeIds.includes(e.to))
        )
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
