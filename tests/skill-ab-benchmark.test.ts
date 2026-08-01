import { describe, expect, it } from "vitest";
import { runSkillAbBenchmark } from "../benchmarks/run-skill-ab-benchmark";

describe("skill-flywheel A/B benchmark harness", () => {
  it("keeps the flywheel quiet on symbol-less history and bounds overhead", async () => {
    const report = await runSkillAbBenchmark();

    // P0-2 extraction quality gate: the benchmark HISTORY corpora contain no
    // project-symbol evidence (file/function/class paths), so no skill nodes
    // may be created from them — generic bare tokens are noise.
    expect(report.skillNodes).toBe(0);
    expect(report.tasks.length).toBeGreaterThanOrEqual(8);

    // No skills → no hint injection; episodes are independent of the gate and
    // still flow through the real recordEpisode path.
    expect(report.hintInjectionRate).toBe(0);
    expect(report.episodeRecallRate).toBeGreaterThan(0);

    // Recalled episode experience is vocabulary-related to the eval tasks.
    expect(report.meanEpisodeRelevance).toBeGreaterThan(0);

    // Overhead stays cheap: hints + episodes must remain a tiny prompt cost.
    expect(report.meanTokenOverheadPerTask).toBeLessThan(200);

    // Report is self-consistent.
    const sumOverhead = report.tasks.reduce((s, t) => s + t.hintTokens + t.episodeTokens, 0);
    expect(report.totalTokenOverhead).toBe(sumOverhead);
  });
});
