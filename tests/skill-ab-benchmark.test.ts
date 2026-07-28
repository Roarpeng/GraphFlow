import { describe, expect, it } from "vitest";
import { runSkillAbBenchmark } from "../benchmarks/run-skill-ab-benchmark";

describe("skill-flywheel A/B benchmark harness", () => {
  it("produces a report with flywheel contribution and bounded overhead", async () => {
    const report = await runSkillAbBenchmark();

    // History simulation actually produced skill nodes.
    expect(report.skillNodes).toBeGreaterThan(0);
    expect(report.tasks.length).toBeGreaterThanOrEqual(8);

    // Flywheel mechanically injects experience for related tasks.
    expect(report.hintInjectionRate).toBeGreaterThan(0);
    expect(report.episodeRecallRate).toBeGreaterThan(0);

    // Injected experience is vocabulary-related to the eval tasks.
    expect(report.meanHintRelevance).toBeGreaterThan(0);
    expect(report.meanEpisodeRelevance).toBeGreaterThan(0);

    // Overhead stays cheap: hints + episodes must remain a tiny prompt cost.
    expect(report.meanTokenOverheadPerTask).toBeLessThan(200);

    // Report is self-consistent.
    const sumOverhead = report.tasks.reduce((s, t) => s + t.hintTokens + t.episodeTokens, 0);
    expect(report.totalTokenOverhead).toBe(sumOverhead);
  });
});
