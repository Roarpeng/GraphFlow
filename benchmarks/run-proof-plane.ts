#!/usr/bin/env node
import { isAbsolute, join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import { getDefaultConfig } from "../src/config/defaults";
import { createGraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import { estimateTokens } from "../src/graph/context-slicer-utils";
import {
  recordContextFidelity,
  recordSavings,
} from "../src/graph/token-savings";

interface ProofQuery {
  query: string;
  englishQuery?: string;
  expectedAnchorIds?: string[];
}

interface ProofRepository {
  root: string;
  includeExtensions?: string[];
  queries: ProofQuery[];
}

function absoluteRoot(root: string): string {
  return isAbsolute(root) ? resolve(root) : resolve(process.cwd(), root);
}

async function main(): Promise<void> {
  const manifestIndex = process.argv.indexOf("--manifest");
  const outputIndex = process.argv.indexOf("--output");
  const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "benchmarks/.cache/proof-plane-results.json";
  if (!manifestPath) throw new Error("usage: run-proof-plane --manifest <proof-manifest.json> [--output <json>]");

  type Manifest = readonly ProofRepository[];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  if (!Array.isArray(manifest)) throw new Error("proof manifest must be an array");

  const repositories: Array<Record<string, unknown>> = [];
  for (const entry of manifest) {
    const root = absoluteRoot(entry.root);
    const config = {
      ...getDefaultConfig(),
      graphPolicy: {
        ...getDefaultConfig().graphPolicy,
        workspaceRoot: root,
        transport: "memory" as const,
        autoIndexOnPreview: false,
        autoIndexOnRun: false,
        autoIndexOnSave: false,
        embeddingProvider: "fnv" as const,
      },
      embeddingPolicy: {
        ...getDefaultConfig().embeddingPolicy,
        enabled: true,
        provider: "hash" as const,
      },
    };
    const client = createGraphClient(config);
    await indexWorkspaceFiles(client, root, {
      ...(entry.includeExtensions ? { includeExtensions: entry.includeExtensions } : {}),
    });

    const queries = [];
    for (const query of entry.queries ?? []) {
      const pkg = await buildEnhancedContextPackage(
        client,
        query.query,
        query.query,
        config.graphPolicy.maxContextTokens,
        {
          workspaceRoot: root,
          ...(query.englishQuery ? { englishQuery: query.englishQuery } : {}),
          enableGraphCompression: true,
        }
      );
      const returnedAnchorIds = pkg.anchorChannel.map((anchor) => anchor.id);
      recordContextFidelity(config, {
        query: query.query,
        expectedAnchorIds: query.expectedAnchorIds ?? [],
        returnedAnchorIds,
        source: "proof-plane",
      });
      const rawTokens = (client.readSnapshot?.().nodes ?? []).reduce(
        (total, node) => total + estimateTokens(node.content),
        0
      );
      recordSavings(config, {
        timestamp: new Date().toISOString(),
        query: query.query,
        rawTokens: Math.max(rawTokens, pkg.tokenEstimate),
        compressedTokens: pkg.tokenEstimate,
        savingsPercent: rawTokens > 0
          ? Math.round(((rawTokens - pkg.tokenEstimate) / rawTokens) * 100)
          : 0,
        source: "run",
        kind: "tokens-not-fidelity",
      });
      queries.push({
        query: query.query,
        returnedAnchorIds,
        tokenEstimate: pkg.tokenEstimate,
        truncated: pkg.truncated,
      });
    }
    repositories.push({ root, queryCount: queries.length, queries });
  }

  mkdirSync(join(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repositories,
  }, null, 2));
  console.log(`[graphflow] proof-plane evaluation written to ${outputPath}`);
}

main().catch((error) => {
  console.error(`[graphflow] proof-plane failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
