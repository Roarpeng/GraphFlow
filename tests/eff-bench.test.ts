import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync as read } from "node:fs";
import {
  CORPUS_PATH,
  compareEffBench,
  runEffBench,
} from "../benchmarks/eff-bench-lib";
import { parseEffTaskCorpus } from "../packages/efficiency-agent/src/corpus";
import { validateTraceProvenance, type TaskTrace } from "../packages/efficiency-agent/src/trace";

describe("eff benchmark corpus (§24 composition)", () => {
  it("ships exactly 50 tasks in the 20/15/10/5 cohort composition", () => {
    const { tasks, violations } = parseEffTaskCorpus(read(CORPUS_PATH, "utf8"));
    expect(violations).toEqual([]);
    expect(tasks).toHaveLength(50);
    const cohorts = tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.cohort] = (acc[t.cohort] ?? 0) + 1;
      return acc;
    }, {});
    expect(cohorts).toEqual({ repetition: 20, regular: 15, complex: 10, failure: 5 });
  });

  it("refuses a malformed corpus instead of benchmarking garbage", () => {
    const { violations } = parseEffTaskCorpus(
      JSON.stringify({ id: "x", cohort: "regular", text: "too short" }) + "\n"
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.startsWith("composition"))).toBe(true);
  });
});

describe("eff benchmark runner (offline arms)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "graphflow-eff-bench-test-"));
  const baselineOut = join(outDir, "baseline.jsonl");
  const shadowOut = join(outDir, "shadow.jsonl");

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("baseline and shadow arms emit provenance-clean traces", async () => {
    // A shared limit slice keeps this fast; the full-50 run is exercised by
    // the npm script and its numbers land in graphflow-out (gitignored).
    const baseline = await runEffBench({ mode: "baseline", limit: 6, outPath: baselineOut });
    expect(baseline.tasksRun).toBe(6);
    expect(baseline.provenanceViolations).toEqual([]);

    const shadow = await runEffBench({ mode: "shadow", limit: 6, outPath: shadowOut });
    expect(shadow.tasksRun).toBe(6);
    expect(shadow.provenanceViolations).toEqual([]);

    // Episode closure is simulated (rep-cohort tasks close as pass), so the
    // repetition family exercises the ADAPT verdict — now gated on text
    // similarity, not outcome score: within this slice the genuinely similar
    // siblings (Jaccard >= 0.5) go ADAPT, the first run and the
    // borderline-dissimilar ones stay FRESH.
    expect(shadow.reuseModeDistribution.FRESH ?? 0).toBeGreaterThanOrEqual(2);
    expect(shadow.reuseModeDistribution.ADAPT ?? 0).toBeGreaterThanOrEqual(2);

    // Every written line parses and passes the R6 gate independently.
    const traces: TaskTrace[] = readFileSync(shadowOut, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TaskTrace);
    expect(traces).toHaveLength(6);
    for (const trace of traces) {
      expect(validateTraceProvenance(trace)).toEqual([]);
      expect(trace.run.mode).toBe("shadow");
      expect(trace.decision).toBeDefined();
      expect(trace.llm.calls).toEqual({ value: 0, provenance: "measured" });
      // Context tokens are honestly labeled proxy until the summary carries
      // real counts — the contract must keep this visible.
      expect(trace.context.tokens.provenance).toBe("proxy");
      expect(trace.context.tokens.method).toBe("descriptor-chars/4");
    }
  }, 60_000);

  it("compare accepts clean arms and reports decision overhead", () => {
    const report = compareEffBench(baselineOut, shadowOut);
    expect(report.ok).toBe(true);
    expect(report.tasksCompared).toBe(6);
    expect(report.baseline!.totalLlmCalls).toBe(0);
    expect(report.shadow!.avgDecisionDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.shadow!.avgDecisionCostShare ?? 0).toBeLessThan(1);
  });

  it("compare refuses a trace with a provenance violation (R6)", () => {
    const dirty = join(outDir, "dirty.jsonl");
    const clean = JSON.parse(
      readFileSync(shadowOut, "utf8").trim().split("\n")[0]!
    ) as TaskTrace;
    const lying: TaskTrace = {
      ...clean,
      llm: { calls: { value: 3, provenance: "estimated" } }, // no method
    };
    writeFileSync(dirty, `${JSON.stringify(clean)}\n${JSON.stringify(lying)}\n`, "utf8");
    const report = compareEffBench(baselineOut, dirty);
    expect(report.ok).toBe(false);
    expect(report.refusedBy?.some((r) => r.includes("estimated values require a method"))).toBe(
      true
    );
  });
});
