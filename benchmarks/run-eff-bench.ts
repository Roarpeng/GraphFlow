/**
 * Efficiency benchmark CLI (2.x plan §25).
 *
 *   npx tsx benchmarks/run-eff-bench.ts run --mode baseline
 *   npx tsx benchmarks/run-eff-bench.ts run --mode shadow
 *   npx tsx benchmarks/run-eff-bench.ts compare graphflow-out/eff-bench/baseline.jsonl graphflow-out/eff-bench/shadow.jsonl
 *
 * Default arms are offline (bridge path, no LLM keys): no worker executes, so
 * they measure packaging + advising cost only. Every trace is unjudged
 * (judged=false) and success rates are N/A. Context tokens are chars/4
 * proxies, never measured. --worker arms run only real validation commands
 * (substrate advisory, or --validation) and are unjudged too. The compare
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
    const workerFlag = flag("worker", rest);
    const worker =
      workerFlag === "typesafe-jev" || workerFlag === "local" || workerFlag === "baseline"
        ? workerFlag
        : undefined;
    const providerFlag = flag("provider", rest);
    const provider =
      providerFlag === "deepseek" || providerFlag === "openai" || providerFlag === "local"
        ? providerFlag
        : undefined;
    const model = flag("model", rest);
    const validation = flag("validation", rest);
    const outPath =
      flag("out", rest) ??
      `graphflow-out/eff-bench/${mode}${worker && worker !== "baseline" ? `-${worker}` : ""}.jsonl`;

    mkdirSync(dirname(outPath), { recursive: true });
    const summary = await runEffBench({
      mode,
      limit,
      outPath,
      worker,
      provider,
      model,
      ...(validation && validation !== "true" ? { validationCommands: [validation] } : {}),
    });

    console.log(
      `mode=${summary.mode} execution=${summary.executionMode} tasks=${summary.tasksRun} out=${summary.outPath}`
    );
    console.log(`scope: ${summary.scope}`);
    console.log(
      `packaged=${summary.packagedCount}/${summary.tasksRun} executed=${summary.executedCount} ` +
        `judged=${summary.judgedTraces} successRate=${summary.successRate === null ? "N/A" : summary.successRate}`
    );
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
    const rate = (r: number | null | undefined): string => (r === null || r === undefined ? "N/A" : String(r));
    console.log(
      `successRate=baseline:${rate(report.baseline?.successRate)} (judged ${report.baseline?.judgedTraces ?? 0}) ` +
        `shadow:${rate(report.shadow?.successRate)} (judged ${report.shadow?.judgedTraces ?? 0})`
    );
    if (report.comparison) {
      console.log(
        `tokenSavingsRate=${(report.comparison.tokenSavingsRate * 100).toFixed(2)}% (provenance: ${report.comparison.tokenProvenance})`
      );
      console.log(`llmCallReductionRate=${(report.comparison.llmCallReductionRate * 100).toFixed(2)}%`);
      console.log(
        `roundsComparison=baseline:${report.baseline?.avgRounds} vs shadow:${report.shadow?.avgRounds} (diff: ${report.comparison.roundsDiff})`
      );
    }
    return;
  }

  console.error(
    "usage: run-eff-bench.ts run [--mode=baseline|shadow] [--limit=N] [--out=PATH] [--worker=baseline|typesafe-jev|local] [--provider=deepseek|openai|local] [--model=NAME] [--validation=CMD] | compare <a.jsonl> <b.jsonl>"
  );
  process.exitCode = 2;
}

void main();
