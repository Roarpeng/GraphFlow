/**
 * Step D — the REAL-provider A/B benchmark (2.x plan §14-0.3 / §22 / §23).
 *
 *   npm run benchmark:real [-- --limit=N --model=NAME --skip-index]
 *
 * Two arms over the same 50-task corpus, same model, same single round:
 *  - baseline: context acquired the TRADITIONAL way — grep the task terms,
 *    read the top matching files — under the SAME char budget as the shadow
 *    arm (the honest §23 counterfactual; a raw-prompt baseline would
 *    understate context cost);
 *  - shadow: GraphFlow's compressed context package (graphflow_context over
 *    THIS repository) is prepended to the task — the efficiency layer's
 *    actual offering — plus the deterministic advisory recorded in the trace.
 *
 * Everything cost-bearing is MEASURED: token counts come from the provider's
 * own usage block (R2 measured), wall time from Date.now, decision cost from
 * the advisory builder. costUsd is the only proxy (assumed price table,
 * method string names the rates). The R6 gate refuses any unprovenanced
 * trace before comparison.
 *
 * This script spends real money by design. Guards: GRAPHFLOW_REAL_BENCH=0
 * refuses to run; --limit caps tasks; sequential calls with a polite delay.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCorpus, readTraces, compareEffBench } from "./eff-bench-lib";
import { buildRealWorkerTrace } from "./eff-bench-lib";
import { resolveConfig } from "../src/config/resolve";
import { resolveConfigSecret } from "../src/config/secrets";
import { previewContext } from "../src/surfaces/cli/runtime";
import { triageTask } from "../src/core/triage";
import { buildEfficiencyAdvisory } from "../src/core/efficiency-advisory";
import { executeOpenAiCompatible } from "../src/routing/protocol-driver";
import type { ProviderTextResult } from "../src/routing/provider-adapters/types";
import {
  measured,
  proxy,
  validateTraceProvenance,
  type TaskTrace,
} from "../packages/efficiency-agent/src/index";

const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(REPO_ROOT, "graphflow-out", "eff-bench");

// Assumed DeepSeek price table (USD per 1M tokens) — PROVENANCE: proxy. The
// method string travels with every costUsd so a wrong table is visible.
const PRICE_INPUT_PER_MTOK = 0.27;
const PRICE_OUTPUT_PER_MTOK = 1.1;

function flag(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CallOutcome {
  ok: boolean;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  error?: string;
}

async function callProvider(
  prompt: string,
  model: string,
  baseUrl: string,
  apiKey: string
): Promise<CallOutcome> {
  const started = Date.now();
  try {
    const result: ProviderTextResult = await executeOpenAiCompatible(
      { prompt, model, maxTokens: 2048, temperature: 0.3 },
      { baseUrl, apiKey, strict: true, timeoutMs: 60_000 }
    );
    const usage = result.usage;
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const ok = result.content.trim().length > 0;
    return {
      ok,
      promptTokens,
      completionTokens,
      durationMs: Date.now() - started,
      ...(ok ? {} : { error: "empty response content" }),
      ...(usage ? {} : { error: "provider returned no usage block" }),
    };
  } catch (error) {
    return {
      ok: false,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function costUsdOf(promptTokens: number, completionTokens: number) {
  return proxy(
    Number(
      (
        (promptTokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
        (completionTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK
      ).toFixed(6)
    ),
    `assumed-price input=${PRICE_INPUT_PER_MTOK}/MTok output=${PRICE_OUTPUT_PER_MTOK}/MTok (deepseek flash table, may drift)`,
    0.5
  );
}

/**
 * Traditional context acquisition (the honest §23 counterfactual): grep the
 * task's terms over the source tree, read the top matching files, cap at the
 * SAME budget as the shadow arm's context block. An agent without GraphFlow
 * reads files this way; a raw-prompt baseline would understate context cost
 * and overstate the shadow arm's input tokens.
 */
function grepContextBlock(taskText: string, budgetChars: number): string {
  const terms = Array.from(
    new Set(
      taskText
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length >= 4)
    )
  ).slice(0, 6);
  if (terms.length === 0) return "";
  const scored: Array<{ file: string; hits: number }> = [];
  for (const dir of ["src", "packages/efficiency-agent/src", "benchmarks"]) {
    for (const term of terms) {
      try {
        const out = execFileSync(
          "grep",
          ["-rli", term, dir, "--include=*.ts"],
          { cwd: REPO_ROOT, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }
        )
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const file of out.slice(0, 8)) {
          const existing = scored.find((s) => s.file === file);
          if (existing) existing.hits += 1;
          else scored.push({ file, hits: 1 });
        }
      } catch {
        // no match for this term — grep exits 1
      }
    }
  }
  scored.sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file));
  const parts: string[] = [];
  let used = 0;
  for (const { file } of scored.slice(0, 3)) {
    try {
      const lines = readFileSync(resolve(REPO_ROOT, file), "utf8").split("\n").slice(0, 250);
      const body = `--- ${file} ---\n${lines.join("\n")}`;
      if (used + body.length > budgetChars) {
        const remaining = budgetChars - used;
        if (remaining > 200) parts.push(body.slice(0, remaining));
        break;
      }
      parts.push(body);
      used += body.length;
    } catch {
      // unreadable file — skip
    }
  }
  return parts.join("\n\n");
}

async function main(): Promise<void> {
  if (process.env.GRAPHFLOW_REAL_BENCH === "0") {
    console.error("refused: GRAPHFLOW_REAL_BENCH=0");
    process.exitCode = 2;
    return;
  }

  const limit = flag("limit", process.argv.slice(2))
    ? Number(flag("limit", process.argv.slice(2)))
    : undefined;
  const tasks = loadCorpus().slice(0, limit ?? 50);

  // Real credentials from the machine's resolved config (deepseek).
  const config = resolveConfig();
  const deepseek = config.providers["deepseek"];
  const apiKey = deepseek?.apiKey ? resolveConfigSecret(deepseek.apiKey) : undefined;
  const baseUrl = (deepseek?.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const model = flag("model", process.argv.slice(2)) ?? config.tiers.economy.model;
  if (!apiKey) {
    console.error("refused: no deepseek credential in the resolved config");
    process.exitCode = 2;
    return;
  }
  console.log(`real A/B: ${tasks.length} tasks | model=${model} | baseUrl=${baseUrl}`);
  console.log(`price table (proxy): input=${PRICE_INPUT_PER_MTOK}/MTok output=${PRICE_OUTPUT_PER_MTOK}/MTok`);

  mkdirSync(OUT_DIR, { recursive: true });
  const baselineTraces: TaskTrace[] = [];
  const shadowTraces: TaskTrace[] = [];
  const violations: string[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    const startedAt = new Date().toISOString();

    // ── baseline arm: traditional grep context under the SAME char budget ──
    const tB = Date.now();
    const grepBlock = grepContextBlock(task.text, 6000);
    const baselineDurationMs = Date.now() - tB;
    const baselinePrompt = grepBlock
      ? `Context (acquired by grep):\n${grepBlock}\n\nTask: ${task.text}`
      : task.text;
    const baselineCall = await callProvider(baselinePrompt, model, baseUrl, apiKey);
    await sleep(800);

    // ── shadow arm: compressed context package + task, plus the advisory ──
    const t0 = Date.now();
    let contextBlock = "";
    let anchors = 0;
    try {
      const pkg = await previewContext(task.text, undefined, REPO_ROOT, undefined, {
        recordDialogue: false,
      });
      contextBlock = pkg.summary.join("\n").slice(0, 6000);
      anchors = pkg.anchors?.length ?? 0;
    } catch (error) {
      console.warn(`  [${task.id}] context packaging failed: ${error instanceof Error ? error.message : error}`);
    }
    const advisoryStart = Date.now();
    const advisory = buildEfficiencyAdvisory({
      task: task.text,
      taskComplexity: triageTask(task.text),
      executionMode: "llm",
      ...(anchors > 0 ? { requiredAnchors: [] } : {}),
      durationMs: 0,
    });
    const decisionMs = Math.max(0, Date.now() - advisoryStart);
    const advisedPrompt = contextBlock
      ? `Context (compressed by GraphFlow):\n${contextBlock}\n\nTask: ${task.text}`
      : task.text;
    const shadowCall = await callProvider(advisedPrompt, model, baseUrl, apiKey);
    const armDurationMs = Date.now() - t0;

    const traceFor = (arm: "baseline" | "shadow", call: CallOutcome, durationMs: number): TaskTrace =>
      buildRealWorkerTrace({
        task: { text: task.text, category: task.category, taskId: advisory.taskId },
        worker: `deepseek:${model}`,
        mode: arm,
        startedAt,
        finishedAt: new Date().toISOString(),
        totalDurationMs: durationMs,
        success: call.ok,
        contextTokens: measured(call.promptTokens),
        llmCalls: measured(1),
        inputTokens: measured(call.promptTokens),
        outputTokens: measured(call.completionTokens),
        totalTokens: measured(call.promptTokens + call.completionTokens),
        costUsd: costUsdOf(call.promptTokens, call.completionTokens),
        anchors,
        rounds: 1,
        validation: [{ name: "non-empty-answer", passed: call.ok }],
        ...(call.error ? { failure: { stage: "llm", reason: call.error } } : {}),
        ...(arm === "shadow"
          ? {
              advisory: {
                taskId: advisory.taskId,
                reuseMode: advisory.reuseMode,
                durationMs: decisionMs,
                llmCalls: 0,
              },
            }
          : {}),
      });

    const baselineTrace = traceFor("baseline", baselineCall, baselineDurationMs + baselineCall.durationMs);
    const shadowTrace = traceFor("shadow", shadowCall, armDurationMs);
    for (const [label, trace] of [["baseline", baselineTrace], ["shadow", shadowTrace]] as const) {
      violations.push(...validateTraceProvenance(trace).map((v) => `${task.id}/${label}: ${v}`));
    }
    baselineTraces.push(baselineTrace);
    shadowTraces.push(shadowTrace);

    const bIn = baselineCall.promptTokens;
    const sIn = shadowCall.promptTokens;
    const delta = bIn > 0 ? Math.round(((sIn - bIn) / bIn) * 100) : 0;
    console.log(
      `  [${i + 1}/${tasks.length}] ${task.id} ${call(baselineCall.ok)}/${call(shadowCall.ok)} ` +
        `in:${bIn}->${sIn} (${delta >= 0 ? "+" : ""}${delta}%) out:${baselineCall.completionTokens}/${shadowCall.completionTokens}` +
        (shadowCall.error ? ` ERR:${shadowCall.error.slice(0, 60)}` : "")
    );
    await sleep(800);
  }

  const write = (name: string, traces: TaskTrace[]): string => {
    const path = resolve(OUT_DIR, name);
    writeFileSync(path, traces.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
    return path;
  };
  const baselinePath = write("real-baseline.jsonl", baselineTraces);
  const shadowPath = write("real-shadow.jsonl", shadowTraces);
  void readTraces; // (compare loads from disk; keep import shape stable)

  console.log(`\nwritten: ${baselinePath}\n         ${shadowPath}`);
  if (violations.length > 0) {
    console.error(`\nprovenance VIOLATIONS (${violations.length}):`);
    for (const v of violations.slice(0, 20)) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  console.log("provenance: CLEAN");

  const report = compareEffBench(baselinePath, shadowPath);
  if (!report.ok) {
    console.error("compare REFUSED by the measurement contract");
    process.exitCode = 1;
    return;
  }
  const b = report.baseline!;
  const s = report.shadow!;
  const inDelta = b.avgContextTokens > 0 ? Math.round(((s.avgContextTokens - b.avgContextTokens) / b.avgContextTokens) * 100) : 0;
  console.log(`\n=== §22 metrics (${report.tasksCompared} tasks) ===`);
  console.log(`Context/input tokens : baseline=${b.avgContextTokens} shadow=${s.avgContextTokens} (${inDelta >= 0 ? "+" : ""}${inDelta}%)`);
  console.log(`LLM calls (total)    : baseline=${b.totalLlmCalls} shadow=${s.totalLlmCalls}`);
  console.log(`Rounds (avg)         : baseline=${b.avgRounds} shadow=${s.avgRounds}`);
  console.log(`Success rate         : baseline=${b.successRate} shadow=${s.successRate}`);
  console.log(`Decision cost share  : ${s.avgDecisionCostShare ?? "n/a"}`);
}

function call(ok: boolean): string {
  return ok ? "OK" : "FAIL";
}

void main();
