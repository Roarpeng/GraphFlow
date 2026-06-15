import type { GraphFlowConfig } from "./schema";
import { validateConfig } from "./loader";

export const SCAFFOLD_TIERS = {
  smart: { provider: "openai", model: "gpt-4.1" },
  economy: { provider: "openai", model: "gpt-4.1-mini" },
} as const;

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-base-zh-v1.5";
export const DEFAULT_MAX_CONTEXT_TOKENS = 1500;
/** Unified output directory for all knowledge-graph artifacts. */
export const DEFAULT_OUTPUT_DIR = "graphflow-out";
/** Pre-v0.6.9 default; upgraded automatically when still present in saved configs. */
export const LEGACY_MAX_CONTEXT_TOKENS = 400;

export function resolveMaxContextTokens(value?: number): number {
  if (value === undefined || value === LEGACY_MAX_CONTEXT_TOKENS) {
    return DEFAULT_MAX_CONTEXT_TOKENS;
  }
  return Math.max(1, Math.floor(value));
}

export function getDefaultConfig(): GraphFlowConfig {
  return validateConfig({
    providers: {},
    tiers: {
      smart: { ...SCAFFOLD_TIERS.smart },
      economy: { ...SCAFFOLD_TIERS.economy },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      enableNearLosslessMode: true,
      autoIndexOnPreview: true,
      autoIndexOnRun: true,
      autoIndexOnSave: true,
      workspaceRoot: process.cwd(),
      includeExtensions: [".ts", ".tsx", ".js", ".jsx", ".md", ".json"],
      transport: "file",
      graphStorePath: `${DEFAULT_OUTPUT_DIR}/graphflow-graph.json`,
      maxContextTokens: 1500,
      layerQuota: { l1: 6, l2: 4, l3: 3 },
      semanticEnrichment: {
        enabled: true,
        mode: "post-index",
        batchSize: 5,
        sleepMs: 0,
        timeoutMs: 5000,
        autoRunOnIndex: true,
      },
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      canaryRatio: 10,
      exportPath: `${DEFAULT_OUTPUT_DIR}/learning-dataset.jsonl`,
      eventsPath: `${DEFAULT_OUTPUT_DIR}/learning-events.jsonl`,
      summaryPath: `${DEFAULT_OUTPUT_DIR}/learning-summary.json`,
      skillEvolution: {
        enabled: true,
        minCoOccur: 2,
        minSuccess: 2,
        enableTripleFusion: true,
      },
    },
    routingPolicy: {
      enableDynamicRouting: true,
      requireApiKeyForHealthy: false,
      providerPriority: ["openai", "anthropic", "bailian", "doubao", "openbmb"],
    },
    skillPolicy: {
      enableSkillFlywheel: true,
      maxSkillHints: 3,
    },
    embeddingPolicy: {
      enabled: true,
      provider: "local",
      model: DEFAULT_EMBEDDING_MODEL,
      vectorStorePath: `${DEFAULT_OUTPUT_DIR}/vectors.db`,
      topK: 8,
      minSimilarity: 0.05,
    },
  });
}

/** Minimal overlay written by `graphflow init`; inherits providers/tiers from root config. */
export function getDefaultOverlayConfig(): GraphFlowConfig {
  const base = getDefaultConfig();
  return validateConfig({
    ...base,
    providers: {},
    tiers: {
      smart: { ...SCAFFOLD_TIERS.smart },
      economy: { ...SCAFFOLD_TIERS.economy },
    },
  });
}
