import { existsSync } from "node:fs";
import { loadConfig, validateConfig } from "../../config/loader";
import type { GraphFlowConfig } from "../../config/schema";
import { orchestrate } from "../../core/orchestrator";
import { createGraphClient } from "../../graph/client-factory";
import { indexWorkspaceFiles } from "../../graph/file-indexer";
import {
  buildLayeredContextPackage,
  createContextRefillManager,
} from "../../graph/context-slicer";

export function getDefaultConfig(): GraphFlowConfig {
  return validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-5.3-codex" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      enableNearLosslessMode: true,
      autoIndexOnPreview: true,
      workspaceRoot: process.cwd(),
      includeExtensions: [".ts", ".tsx", ".js", ".jsx", ".md", ".json"],
      transport: "memory",
      maxContextTokens: 400,
      layerQuota: { l1: 6, l2: 4, l3: 3 },
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      canaryRatio: 10,
      exportPath: "tmp/learning-dataset.jsonl",
    },
  });
}

export function resolveConfig(path = "graphflow.config.json"): GraphFlowConfig {
  if (existsSync(path)) {
    return loadConfig(path);
  }

  return getDefaultConfig();
}

export interface ContextPreviewResult {
  summaryCount: number;
  anchorCount: number;
  tokenEstimate: number;
  truncated: boolean;
  anchorsByLayer: {
    l1: number;
    l2: number;
    l3: number;
  };
  refillPreview: string[];
}

export async function previewContext(query: string, configPath?: string): Promise<ContextPreviewResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);

  if (config.graphPolicy.autoIndexOnPreview) {
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
  }

  const packageOptions = config.graphPolicy.layerQuota
    ? { layerQuota: config.graphPolicy.layerQuota }
    : undefined;

  const pkg = await buildLayeredContextPackage(
    graphClient,
    query,
    config.graphPolicy.maxContextTokens,
    packageOptions
  );

  const refill = createContextRefillManager(
    graphClient,
    config.graphPolicy.maxContextTokens,
    packageOptions
  );
  await refill.initialPackage(query);
  const refillPreview = await refill.refill([query]);

  return {
    summaryCount: pkg.summaryChannel.length,
    anchorCount: pkg.anchorChannel.length,
    tokenEstimate: pkg.tokenEstimate,
    truncated: pkg.truncated,
    anchorsByLayer: {
      l1: pkg.anchorChannel.filter((item) => item.layer === "L1").length,
      l2: pkg.anchorChannel.filter((item) => item.layer === "L2").length,
      l3: pkg.anchorChannel.filter((item) => item.layer === "L3").length,
    },
    refillPreview,
  };
}

export interface GraphIndexResult {
  indexedFiles: number;
  indexedSymbols: number;
}

export async function indexGraph(rootDir?: string, configPath?: string): Promise<GraphIndexResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const targetDir = rootDir || config.graphPolicy.workspaceRoot || process.cwd();

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  return indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
  });
}

export async function runTask(task: string, configPath?: string): Promise<string> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const orchestrateOptions = {
    graphClient,
    enableAutoGraphSync: config.graphPolicy.enableAutoBuild,
    maxContextTokens: config.graphPolicy.maxContextTokens,
    ...(config.graphPolicy.enableNearLosslessMode !== undefined
      ? { enableNearLosslessMode: config.graphPolicy.enableNearLosslessMode }
      : {}),
    ...(config.graphPolicy.layerQuota ? { layerQuota: config.graphPolicy.layerQuota } : {}),
  };

  const result = await orchestrate({ task }, orchestrateOptions);

  return `status=${result.status}; attempts=${result.attempts}; feedback=${result.feedback}`;
}
