import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CORPUS_QUERIES,
  parseCorpusRoot,
  runTokenBenchmark,
  savingsPercent,
} from "../benchmarks/run-token-benchmark.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("token benchmark: savings math", () => {
  it("computes savings as (baseline - graphflow) / baseline * 100", () => {
    expect(savingsPercent(4000, 1000)).toBe(75);
    expect(savingsPercent(2000, 500)).toBe(75);
    expect(savingsPercent(1000, 1000)).toBe(0);
    expect(savingsPercent(0, 0)).toBe(0);
  });
});

describe("token benchmark: external corpus mode", () => {
  it("parses --corpus and requires an existing directory", () => {
    const existing = mkdtempSync(join(tmpdir(), "gf-corpus-ok-"));
    dirs.push(existing);
    expect(parseCorpusRoot([])).toBeUndefined();
    expect(parseCorpusRoot([`--corpus=${existing}`])).toBe(existing);
    expect(() => parseCorpusRoot(["--corpus=/definitely/missing/dir"])).toThrow(/does not exist/);
  });

  it("defaults queries to a generic cross-repository set", () => {
    expect(CORPUS_QUERIES.length).toBeGreaterThanOrEqual(5);
    expect(CORPUS_QUERIES).toContain("error handling");
    expect(CORPUS_QUERIES).not.toContain("orchestrator");
  });

  it("external corpus mode writes a separate results file with provenance", async () => {
    const ws = mkdtempSync(join(tmpdir(), "gf-token-corpus-"));
    dirs.push(ws);
    const src = join(ws, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "router.ts"),
      "export class Router {\n  // error handling lives here\n  route(path: string): string {\n    return path.toUpperCase();\n  }\n  cacheLayer(): void {}\n}\n"
    );
    writeFileSync(
      join(src, "cache.ts"),
      "export class CacheLayer {\n  // cache layer with error handling\n  get(key: string): string | undefined {\n    return key.length > 0 ? key : undefined;\n  }\n}\n"
    );
    const resultsPath = join(ws, "external-results.md");
    await runTokenBenchmark({ corpusRoot: ws, resultsPath });
    const report = readFileSync(resultsPath, "utf8");
    expect(report).toContain("Corpus (external");
    expect(report).toContain("Arm A");
    expect(report).toContain("Arm B");
    // Machine-readable provenance file exists beside it.
    const machinePath = resultsPath.replace(/\.md$/, ".json");
    const machine = JSON.parse(readFileSync(machinePath, "utf8")) as {
      inputs: { corpus: { kind: string } };
    };
    expect(machine.inputs.corpus.kind).toBe("external");
  });
});
