import type { GraphFlowConfig } from "./schema";
import { validateConfig } from "./loader";
import { DEFAULT_INCLUDE_EXTENSIONS } from "./include-extensions.js";

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
      enableDialogueThread: true,
      workspaceRoot: process.cwd(),
      includeExtensions: [...DEFAULT_INCLUDE_EXTENSIONS],
      // 默认使用 auto 后端：sqlite 优先（FTS5 索引，避免大仓库下整文件读写放大），
      // better-sqlite3 可选依赖缺失时透明降级为 file JSON 存储（见 client-factory）。
      // 用户配置中显式声明的 transport（包括 "file"）保持不变，不做迁移。
      transport: "auto",
      graphStorePath: `${DEFAULT_OUTPUT_DIR}/graphflow-graph.sqlite`,
      maxContextTokens: 1500,
      layerQuota: { l1: 6, l2: 4, l3: 3 },
      // P0-1: offline-safe default — FNV-1a hash embeddings, no model download.
      // Opt into semantic recall by setting embeddingProvider: "transformers".
      embeddingProvider: "fnv",
      compression: {
        enableGraphCompression: true,
        enableAdaptiveBudget: true,
      },
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      exportPath: `${DEFAULT_OUTPUT_DIR}/learning-dataset.jsonl`,
      eventsPath: `${DEFAULT_OUTPUT_DIR}/learning-events.jsonl`,
      summaryPath: `${DEFAULT_OUTPUT_DIR}/learning-summary.json`,
    },
    routingPolicy: {
      enableDynamicRouting: true,
      requireApiKeyForHealthy: false,
      providerPriority: ["openai", "deepseek", "anthropic", "bailian", "doubao"],
      enableProviderTools: true,
    },
    skillPolicy: {
      enableSkillFlywheel: true,
      maxSkillHints: 3,
    },
    embeddingPolicy: {
      enabled: true,
      provider: "transformers",
      model: DEFAULT_EMBEDDING_MODEL,
      vectorStorePath: `${DEFAULT_OUTPUT_DIR}/vectors.db`,
      topK: 8,
      minSimilarity: 0.05,
      enableFullGraphVectorRecall: false,
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
