/**
 * export-retrieval-dataset.ts — Regenerate the public retrieval golden dataset
 * from the TypeScript source of truth (`retrieval-golden-data.ts`).
 *
 * Usage: npm run dataset:retrieval
 *
 * Outputs (committed, downloadable):
 *   - benchmarks/datasets/retrieval-golden-v1.json
 *   - benchmarks/datasets/retrieval-golden-v1.jsonl
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_SET, NEGATIVE_SAMPLES } from "./retrieval-golden-data.js";
import { getCommitHash } from "./bench-meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(__dirname, "datasets");
const DATASET_ID = "retrieval-golden-v1";
const SCHEMA_VERSION = 1;
const SOURCE_OF_TRUTH = "benchmarks/retrieval-golden-data.ts";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function domainCounts(entries: typeof GOLDEN_SET): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.domain] = (counts[entry.domain] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

interface DatasetDocument {
  schemaVersion: number;
  name: string;
  datasetId: string;
  license: string;
  licenseUrl: string;
  licensePointer: string;
  sourceOfTruth: string;
  regenerator: string;
  /** GraphFlow package version at export time (informational; dataset id is versioned separately). */
  graphflowVersion: string;
  /** Git commit note at export time — pin when citing results. */
  commit: string;
  generatedAt: string;
  description: string;
  corpus: string;
  evaluation: {
    runner: string;
    methodologyDocs: string[];
    metrics: string[];
    primaryMetrics: string[];
    hitDefinition: string;
    ranking: string;
    negativeSamples: string;
  };
  queryCount: number;
  negativeSampleCount: number;
  domainCounts: Record<string, number>;
  queries: Array<{
    id: string;
    query: string;
    expectAny: string[];
    domain: string;
    topK?: number;
    mustNotContain?: string[];
  }>;
  negativeSamples: Array<{
    id: string;
    query: string;
    mustNotContain: string[];
  }>;
}

function buildDocument(): DatasetDocument {
  const queries = GOLDEN_SET.map((entry, index) => {
    const row: DatasetDocument["queries"][number] = {
      id: `q${String(index + 1).padStart(3, "0")}`,
      query: entry.query,
      expectAny: [...entry.expectAny],
      domain: entry.domain,
    };
    if (entry.topK !== undefined) row.topK = entry.topK;
    if (entry.mustNotContain !== undefined) row.mustNotContain = [...entry.mustNotContain];
    return row;
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    name: "GraphFlow code-domain retrieval golden set",
    datasetId: DATASET_ID,
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    licensePointer: "LICENSE",
    sourceOfTruth: SOURCE_OF_TRUTH,
    regenerator: "npm run dataset:retrieval",
    graphflowVersion: packageVersion(),
    commit: getCommitHash(),
    generatedAt: new Date().toISOString(),
    description:
      "Open evaluation queries for GraphFlow graph retrieval on a code knowledge graph. " +
      "Each query lists alternative path/symbol substrings (expectAny); a hit is when any " +
      "substring appears in ranked retrieval anchors. Use with `npm run bench:retrieval` " +
      "against this repository's `src/` corpus (or an equivalent GraphFlow-indexed tree).",
    corpus: "GraphFlow repository `src/` (in-memory index via bench:retrieval)",
    evaluation: {
      runner: "npm run bench:retrieval",
      methodologyDocs: [
        "benchmarks/README.md",
        "benchmarks/RETRIEVAL-EVAL-RESULTS.md",
        "docs/benchmark-standards.md",
      ],
      metrics: ["Hit@1", "Hit@3", "Hit@5", "Hit@10", "MRR", "NDCG@5", "NDCG@10"],
      primaryMetrics: ["Hit@5", "MRR", "NDCG@5"],
      hitDefinition:
        "Case-insensitive: any expectAny substring appears in ranked anchor ids " +
        "(and/or summary+anchor text for the textHit rate). Hit@K is true when the " +
        "first matching anchor is within the top K positions (0-based rank < K).",
      ranking:
        "MRR uses reciprocal rank of the first hit (1/(rank+1)). NDCG@K treats the " +
        "first hit as a single relevant document at its rank (binary relevance).",
      negativeSamples:
        "negativeSamples entries must not surface mustNotContain path substrings " +
        "(decoy-bleed / precision guard).",
    },
    queryCount: queries.length,
    negativeSampleCount: NEGATIVE_SAMPLES.length,
    domainCounts: domainCounts(GOLDEN_SET),
    queries,
    negativeSamples: NEGATIVE_SAMPLES.map((sample, index) => ({
      id: `n${String(index + 1).padStart(3, "0")}`,
      query: sample.query,
      mustNotContain: [...sample.mustNotContain],
    })),
  };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const doc = buildDocument();
  const jsonPath = join(OUT_DIR, `${DATASET_ID}.json`);
  const jsonlPath = join(OUT_DIR, `${DATASET_ID}.jsonl`);

  writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  const jsonlLines = [
    ...doc.queries.map((q) => JSON.stringify({ type: "query", ...q })),
    ...doc.negativeSamples.map((n) => JSON.stringify({ type: "negative", ...n })),
  ];
  writeFileSync(jsonlPath, `${jsonlLines.join("\n")}\n`, "utf8");

  process.stdout.write(
    `Wrote ${doc.queryCount} queries + ${doc.negativeSampleCount} negatives →\n` +
      `  ${jsonPath}\n` +
      `  ${jsonlPath}\n` +
      `sourceOfTruth=${SOURCE_OF_TRUTH} commit=${doc.commit} graphflowVersion=${doc.graphflowVersion}\n`
  );
}

main();
