/**
 * Efficiency benchmark CLI (2.x plan §25).
 *
 *   npx tsx benchmarks/run-eff-bench.ts run --mode baseline
 *   npx tsx benchmarks/run-eff-bench.ts run --mode shadow
 *   npx tsx benchmarks/run-eff-bench.ts compare graphflow-out/eff-bench/baseline.jsonl graphflow-out/eff-bench/shadow.jsonl
 *
 * Arms are offline (bridge path, no LLM keys) and deterministic in shape:
 * they measure packaging + advising cost, not worker outcomes. The compare
 * subcommand refuses traces that violate the measurement contract.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { compareEffBench, runEffBench } from "./eff-bench-lib";

function flag(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) {
      // Space-separated form: --mode value (value missing means boolean flag).
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
      return "true";
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "run") {
    const mode = flag("mode", rest) === "shadow" ? "shadow" : "baseline";
    const limit = flag("limit", rest) ? Number(flag("limit", rest)) : undefined;
    const outPath =
      flag("out", rest) ?? `graphflow-out/eff-bench/${mode}.jsonl`;
    mkdirSync(dirname(outPath), { recursive: true });
    const summary = await runEffBench({ mode, limit, outPath });
    console.log(`mode=${summary.mode} tasks=${summary.tasksRun} out=${summary.outPath}`);
    console.log(`byCohort=${JSON.stringify(summary.byCohort)}`);
    console.log(`reuseMode=${JSON.stringify(summary.reuseModeDistribution)}`);
    console.log(
      `avgDecisionMs=${summary.avgDecisionDurationMs} totalRunMs=${summary.totalRunMs}`
    );
    console.log(
      summary.provenanceViolations.length === 0
        ? "provenance=clean"
        : `provenance=VIOLATIONS\n${summary.provenanceViolations.join("\n")}`
    );
    process.exitCode = summary.provenanceViolations.length === 0 ? 0 : 1;
    return;
  }

  if (command === "compare") {
    const [baselinePath, shadowPath] = rest;
    if (!baselinePath || !shadowPath) {
      console.error("usage: compare <baseline.jsonl> <shadow.jsonl>");
      process.exitCode = 2;
      return;
    }
    const report = compareEffBench(baselinePath, shadowPath);
    if (!report.ok) {
      console.error(`compare REFUSED — measurement contract violations:`);
      for (const reason of report.refusedBy ?? []) {
        console.error(`  - ${reason}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`tasksCompared=${report.tasksCompared}`);
    console.log(`baseline=${JSON.stringify(report.baseline)}`);
    console.log(`shadow=${JSON.stringify(report.shadow)}`);
    return;
  }

  console.error("usage: run-eff-bench.ts run [--mode=baseline|shadow] [--limit=N] [--out=PATH] | compare <a.jsonl> <b.jsonl>");
  process.exitCode = 2;
}

void main();
