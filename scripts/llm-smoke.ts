#!/usr/bin/env node
/**
 * Optional LLM smoke gate (CI): with a REAL provider key present, one live
 * plan round-trip must report planSource === "llm". Everything else in CI
 * runs offline with mocked providers, so "probe green, execution broken"
 * regressions (revoked key, changed API shape, routing regression) are only
 * catchable here. Runs ONLY when GRAPHFLOW_LLM_SMOKE_KEY is set — the job is
 * skipped silently otherwise.
 *
 * Env:
 *   GRAPHFLOW_LLM_SMOKE_KEY    API key (required to do anything)
 *   GRAPHFLOW_LLM_SMOKE_PROVIDER  provider name (default deepseek)
 *   GRAPHFLOW_LLM_SMOKE_BASE_URL  (default https://api.deepseek.com)
 *   GRAPHFLOW_LLM_SMOKE_MODEL     (default deepseek-v4-flash)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const key = process.env.GRAPHFLOW_LLM_SMOKE_KEY?.trim();
  if (!key) {
    console.log("[llm-smoke] GRAPHFLOW_LLM_SMOKE_KEY not set — nothing to do (job is opt-in).");
    return;
  }
  const provider = (process.env.GRAPHFLOW_LLM_SMOKE_PROVIDER ?? "deepseek").trim();
  const baseUrl = (process.env.GRAPHFLOW_LLM_SMOKE_BASE_URL ?? "https://api.deepseek.com").trim();
  const model = (process.env.GRAPHFLOW_LLM_SMOKE_MODEL ?? "deepseek-v4-flash").trim();

  const root = mkdtempSync(join(tmpdir(), "gf-llm-smoke-"));
  const envKey = `${provider.toUpperCase()}_API_KEY`;
  process.env[envKey] = key;
  if (provider === "openai" || provider === "deepseek") {
    process.env[`${provider.toUpperCase()}_BASE_URL`] = baseUrl;
  }

  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: { [provider]: { apiKey: key, baseUrl } },
      tiers: { smart: { provider, model }, economy: { provider, model } },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: { transport: "memory", autoIndexOnPreview: false, autoIndexOnRun: false },
    }),
    "utf8"
  );

  try {
    const { planAndBrainstormResult } = await import("../src/surfaces/cli/runtime/routing.js");
    const result = await planAndBrainstormResult("add a tiny retry helper to src/utils", configPath);
    console.log(`[llm-smoke] planSource=${result.planSource} probe.ok=${result.probe?.ok}`);
    if (result.probe && !result.probe.ok) {
      console.error(`[llm-smoke] FAIL: probe rejected the provider: ${result.probe.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.planSource !== "llm") {
      console.error(
        `[llm-smoke] FAIL: expected planSource=llm with a real key, got ${result.planSource}` +
          (result.degradeReason ? ` (${result.degradeReason})` : "")
      );
      process.exitCode = 1;
      return;
    }
    console.log("[llm-smoke] OK: real LLM plan round-trip succeeded end to end.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[llm-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
