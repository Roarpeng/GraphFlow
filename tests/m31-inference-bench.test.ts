import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    const providerMode = process.env.GRAPHFLOW_OPENBMB_MODE ?? "embedded";
    const engine = process.env.GRAPHFLOW_MINICPM_ENGINE ?? "command";
    const workspaceRoot = process.cwd();
    const reportDir = join(workspaceRoot, "tmp");
    const timestamp = new Date().toISOString();
    const report = {
      benchmark: "m31-inference-bench",
      timestamp,
      providerMode,
      engine,
      model: process.env.GRAPHFLOW_BENCH_MODEL ?? "minicpm-1b",
      promptCount: prompts.length,
      elapsedMs,
      outputChars: totalChars,
      throughputCharsPerSecond: tpsApprox,
      profiles: buildProfileSummary(tpsApprox),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
    };

    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "m31-inference-bench.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(join(reportDir, "m31-inference-bench.md"), renderMarkdownReport(report), "utf8");

    expect(tpsApprox).toBeGreaterThan(0);
  }, 120000);
});

function buildProfileSummary(measuredThroughput: number): Array<{
  profile: "cpu" | "metal" | "cuda";
  targetTokensPerSecond: number;
  measuredCharsPerSecond: number;
  status: "below-target" | "at-risk" | "target-ready";
}> {
  const profiles: Array<{ profile: "cpu" | "metal" | "cuda"; targetTokensPerSecond: number }> = [
    { profile: "cpu", targetTokensPerSecond: 40 },
    { profile: "metal", targetTokensPerSecond: 120 },
    { profile: "cuda", targetTokensPerSecond: 200 },
  ];

  return profiles.map((profile) => ({
    ...profile,
    measuredCharsPerSecond: measuredThroughput,
    status:
      measuredThroughput >= profile.targetTokensPerSecond
        ? "target-ready"
        : measuredThroughput >= profile.targetTokensPerSecond * 0.6
          ? "at-risk"
          : "below-target",
  }));
}

function renderMarkdownReport(report: {
  benchmark: string;
  timestamp: string;
  providerMode: string;
  engine: string;
  model: string;
  promptCount: number;
  elapsedMs: number;
  outputChars: number;
  throughputCharsPerSecond: number;
  profiles: Array<{
    profile: string;
    targetTokensPerSecond: number;
    measuredCharsPerSecond: number;
    status: string;
  }>;
  environment: { platform: string; arch: string; node: string };
}): string {
  const lines = [
    "# M31 Inference Benchmark",
    "",
    `- Timestamp: ${report.timestamp}`,
    `- Model: ${report.model}`,
    `- Provider mode: ${report.providerMode}`,
    `- Engine: ${report.engine}`,
    `- Prompt count: ${report.promptCount}`,
    `- Elapsed ms: ${report.elapsedMs}`,
    `- Output chars: ${report.outputChars}`,
    `- Throughput chars/s: ${report.throughputCharsPerSecond}`,
    `- Environment: ${report.environment.platform}/${report.environment.arch} node ${report.environment.node}`,
    "",
    "## Profiles",
    "",
    "| Profile | Target tok/s | Measured chars/s | Status |",
    "| --- | ---: | ---: | --- |",
    ...report.profiles.map(
      (profile) =>
        `| ${profile.profile} | ${profile.targetTokensPerSecond} | ${profile.measuredCharsPerSecond} | ${profile.status} |`
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
}
