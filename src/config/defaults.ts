import type { GraphFlowConfig } from "./schema";
import { validateConfig } from "./loader";

export const SCAFFOLD_TIERS = {
  smart: { provider: "openai", model: "gpt-4.1" },
  economy: { provider: "openai", model: "gpt-4.1-mini" },
} as const;

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-base-zh-v1.5";

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
      workspaceRoot: process.cwd(),
      includeExtensions: [".ts", ".tsx", ".js", ".jsx", ".md", ".json"],
      transport: "file",
      graphStorePath: "tmp/graphflow-graph.json",
      maxContextTokens: 400,
      layerQuota: { l1: 6, l2: 4, l3: 3 },
      semanticEnrichment: {
        enabled: true,
        mode: "post-index",
        model: "minicpm5-1b",
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
      exportPath: "tmp/learning-dataset.jsonl",
      eventsPath: "tmp/learning-events.jsonl",
      summaryPath: "tmp/learning-summary.json",
      skillEvolution: {
        enabled: true,
        model: "minicpm5-1b",
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
      vectorStorePath: ".graphflow-cache/vectors.db",
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
