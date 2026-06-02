import { describe, expect, it } from "vitest";
import { openbmbGenerateText } from "../src/routing/provider-adapters/openbmb";

const runPerf = process.env.GRAPHFLOW_RUN_PERF === "1";
const perfDescribe = runPerf ? describe : describe.skip;

perfDescribe("M31 inference benchmark", () => {
  it("measures throughput for openbmb provider path", async () => {
    const prompts = Array.from({ length: 20 }, (_, i) => `summarize function signature #${i}`);
    const startedAt = Date.now();
    let totalChars = 0;

    for (const prompt of prompts) {
      const text = await openbmbGenerateText({
        prompt,
        model: process.env.GRAPHFLOW_BENCH_MODEL ?? "minicpm-1b",
      });
      totalChars += text.length;
    }

    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const tpsApprox = Math.round((totalChars / elapsedMs) * 1000);

    expect(tpsApprox).toBeGreaterThan(0);
  }, 120000);
});
