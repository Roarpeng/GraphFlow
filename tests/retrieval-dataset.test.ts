/**
 * Ensures the published retrieval golden dataset stays in sync with the
 * TypeScript source of truth (`benchmarks/retrieval-golden-data.ts`).
 *
 * Regenerate with: `npm run dataset:retrieval`
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GOLDEN_SET, NEGATIVE_SAMPLES } from "../benchmarks/retrieval-golden-data";

const DATASET_JSON = join(process.cwd(), "benchmarks/datasets/retrieval-golden-v1.json");
const DATASET_JSONL = join(process.cwd(), "benchmarks/datasets/retrieval-golden-v1.jsonl");

interface DatasetDoc {
  schemaVersion: number;
  datasetId: string;
  license: string;
  licensePointer: string;
  sourceOfTruth: string;
  graphflowVersion: string;
  commit: string;
  queryCount: number;
  negativeSampleCount: number;
  domainCounts: Record<string, number>;
  evaluation: {
    primaryMetrics: string[];
    runner: string;
  };
  queries: Array<{
    id: string;
    query: string;
    expectAny: string[];
    domain: string;
    topK?: number;
  }>;
  negativeSamples: Array<{
    id: string;
    query: string;
    mustNotContain: string[];
  }>;
}

describe("retrieval golden open dataset", () => {
  it("dataset JSON exists and parses", () => {
    expect(existsSync(DATASET_JSON)).toBe(true);
    const raw = readFileSync(DATASET_JSON, "utf8");
    const doc = JSON.parse(raw) as DatasetDoc;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.datasetId).toBe("retrieval-golden-v1");
    expect(doc.license).toBe("Apache-2.0");
    expect(doc.licensePointer).toBe("LICENSE");
    expect(doc.sourceOfTruth).toBe("benchmarks/retrieval-golden-data.ts");
    expect(doc.graphflowVersion.length).toBeGreaterThan(0);
    expect(doc.commit.length).toBeGreaterThan(0);
    expect(doc.evaluation.runner).toBe("npm run bench:retrieval");
    expect(doc.evaluation.primaryMetrics).toEqual(
      expect.arrayContaining(["Hit@5", "MRR", "NDCG@5"])
    );
  });

  it("entry counts and queries match TypeScript source of truth", () => {
    const doc = JSON.parse(readFileSync(DATASET_JSON, "utf8")) as DatasetDoc;
    expect(doc.queryCount).toBe(GOLDEN_SET.length);
    expect(doc.queries).toHaveLength(GOLDEN_SET.length);
    expect(doc.negativeSampleCount).toBe(NEGATIVE_SAMPLES.length);
    expect(doc.negativeSamples).toHaveLength(NEGATIVE_SAMPLES.length);

    for (let i = 0; i < GOLDEN_SET.length; i++) {
      expect(doc.queries[i]?.query).toBe(GOLDEN_SET[i]?.query);
      expect(doc.queries[i]?.domain).toBe(GOLDEN_SET[i]?.domain);
      expect(doc.queries[i]?.expectAny).toEqual([...GOLDEN_SET[i]!.expectAny]);
      expect(doc.queries[i]?.topK).toBe(GOLDEN_SET[i]?.topK);
    }

    for (let i = 0; i < NEGATIVE_SAMPLES.length; i++) {
      expect(doc.negativeSamples[i]?.query).toBe(NEGATIVE_SAMPLES[i]?.query);
      expect(doc.negativeSamples[i]?.mustNotContain).toEqual([
        ...NEGATIVE_SAMPLES[i]!.mustNotContain,
      ]);
    }

    const expectedDomains: Record<string, number> = {};
    for (const entry of GOLDEN_SET) {
      expectedDomains[entry.domain] = (expectedDomains[entry.domain] ?? 0) + 1;
    }
    expect(doc.domainCounts).toEqual(expectedDomains);
  });

  it("JSONL exists and line count matches queries + negatives", () => {
    expect(existsSync(DATASET_JSONL)).toBe(true);
    const lines = readFileSync(DATASET_JSONL, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(GOLDEN_SET.length + NEGATIVE_SAMPLES.length);
    const first = JSON.parse(lines[0]!) as { type: string; query: string };
    expect(first.type).toBe("query");
    expect(first.query).toBe(GOLDEN_SET[0]?.query);
  });
});
