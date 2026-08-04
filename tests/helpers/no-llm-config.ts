import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Write an isolated GraphFlow config with no provider credentials and return
 * its path.
 *
 * Why: `resolveConfig(explicitPath)` loads that file standalone (no merge with
 * the machine-global `~/.graphflow.config.json` or the repo root config), so
 * `orchestrate()` / CLI runtime calls take the deterministic local heuristic
 * path. Without this, tests running on a machine that has real API keys
 * configured silently make live LLM calls (brainstorm/plan/plannerDraft),
 * turning unit tests into 30-60s network-bound flakes.
 */
export function createNoLlmConfigPath(extra?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "graphflow-test-config-"));
  const configPath = join(dir, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      // REQUIRED: validateConfig rejects configs without a positive runTokenCap
      // and without learningPolicy, in which case loadConfigSafe silently falls
      // back to the DEFAULT config (embeddings on, auto transport, auto-index
      // the real workspace) — defeating the whole point of this sandbox.
      budgetPolicy: { runTokenCap: 2000 },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        exportPath: join(dir, "learning.jsonl"),
      },
      // Prevent transformers model downloads/loads in tests: a config without
      // embeddingPolicy inherits `enabled: true` + `transformers` from the
      // loader defaults, which can block a test for the full 60s embedding
      // timeout on machines without a warm model cache.
      embeddingPolicy: { enabled: false },
      // Keep tests hermetic: in-memory graph, never index the real workspace
      // or touch the repo's graphflow-out store as a side effect.
      graphPolicy: {
        transport: "memory",
        autoIndexOnRun: false,
        autoIndexOnPreview: false,
        autoIndexOnSave: false,
      },
      ...extra,
    })
  );
  return configPath;
}
