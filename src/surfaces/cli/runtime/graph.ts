import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../../../config/resolve";
import { resolveGraphStorePath } from "../../../config/paths";
import type { GraphFlowConfig } from "../../../config/schema";
import type { GraphEdge, GraphNode } from "../../../core/types";
import { createGraphClient, type GraphClient } from "../../../graph/client-factory";
import {
  createContextRefillManager,
} from "../../../graph/context-slicer";
import { indexWorkspaceFiles, clearGraphIndexArtifacts, hasPendingGraphIndexWork, indexSingleFile } from "../../../graph/file-indexer";
import { enrichGraphSemanticsSilent, type EnricherOptions } from "../../../graph/semantic-enricher";
import { sampleGraphForSnapshot } from "../../../graph/snapshot-view.js";
import { getSavingsStats, resetSavingsStats, recordSavings } from "../../../graph/token-savings.js";
import { collectMetrics } from "../../../graph/metrics.js";
import { resolveModelForRole } from "../../../routing/model-router";
import { buildProviderHealthMap } from "../../../routing/provider-health";
import { withFileLock } from "../../../utils/file-lock";
import { logger } from "../../../utils/logger";
import {
  applyEnrichmentProviderEnv,
  applyOpenBmbRuntimeEnv,
  buildEmbeddingOptions,
} from "./env.js";
import {
  calculateBudgetUsedPercent,
  calculateSavingsPercent,
  estimateRawContextTokens,
  getFileSize,
  loadGraphStore,
  parseSkillInsight,
  resolveGraphStoreAfterIndex,
  sha256File,
} from "./helpers.js";
import type {
  ContextPreviewResult,
  GraphIndexResult,
  GraphRebuildResult,
  GraphSnapshotResult,
  ModelDownloadProgress,
  ModelDownloadResult,
  SkillInsightItem,
  SkillInsightsResult,
} from "./types.js";

async function maybeRunSemanticEnrichment(
  config: GraphFlowConfig,
  graphClient: GraphClient
): Promise<void> {
  const enrichPolicy = config.graphPolicy.semanticEnrichment;
  if (!enrichPolicy?.enabled || !enrichPolicy.autoRunOnIndex || enrichPolicy.mode === "off") {
    return;
  }

  const selection = resolveModelForRole("enricher");
  const health = buildProviderHealthMap(config);
  if (!health[selection.provider]) {
    logger.warn(
      `Skipping semantic enrichment: ${selection.provider} provider is not configured or healthy`
    );
    return;
  }

  applyEnrichmentProviderEnv(config);

  try {
    await enrichGraphSemanticsSilent(graphClient, {
      ...(enrichPolicy.batchSize !== undefined ? { batchSize: enrichPolicy.batchSize } : {}),
      ...(enrichPolicy.sleepMs !== undefined ? { sleepMs: enrichPolicy.sleepMs } : {}),
      ...(enrichPolicy.model ? { model: enrichPolicy.model } : {}),
      ...(enrichPolicy.timeoutMs !== undefined ? { timeoutMs: enrichPolicy.timeoutMs } : {}),
    });
  } catch (error) {
    logger.warn({ error }, "Semantic enrichment skipped after provider failure");
  }
}

export async function previewContext(query: string, configPath?: string): Promise<ContextPreviewResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);

  if (config.graphPolicy.autoIndexOnPreview) {
    const root = config.graphPolicy.workspaceRoot ?? process.cwd();
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    if (hasPendingGraphIndexWork(root, indexOptions)) {
      await indexWorkspaceFiles(graphClient, root, {
        ...indexOptions,
      });
    }
  }

  const packageOptions: import("../../../graph/context-slicer").LayeredPackageOptions = {
    ...(config.graphPolicy.layerQuota ? { layerQuota: config.graphPolicy.layerQuota } : {}),
    ...buildEmbeddingOptions(config),
  };

  const compressionPolicy = config.graphPolicy.compression;

  // Graph-structure compression is zero-cost; enabled by default unless explicitly disabled.
  packageOptions.enableGraphCompression = compressionPolicy?.enableGraphCompression !== false;

  // HNSW ANN for large candidate sets; enabled by default unless explicitly disabled.
  packageOptions.enableHnsw = compressionPolicy?.enableHnsw !== false;

  // RepoMap overview fallback for tight budgets (opt-in).
  if (compressionPolicy?.enableRepoMapFallback === true) {
    packageOptions.enableRepoMapFallback = true;
  }

  // Semantic compression (minicpm/economy LLM) is opt-in via config.
  const compressionEnabled = compressionPolicy?.enabled === true;
  if (compressionEnabled) {
    try {
      const { resolveCompressionModel } = await import("../../../graph/compression-model.js");
      const model = await resolveCompressionModel(config, configPath);
      if (model.available) {
        packageOptions.enableSemanticCompression = true;
        packageOptions.compressionModel = model;
      } else {
        // No usable model → degrade gracefully to graph-structure-only compression.
        logger.info("Semantic compression skipped: no usable model (graph-structure compression still active)");
      }
    } catch (error) {
      logger.warn({ error }, "Compression model unavailable; using structure-only compression");
    }
  }

  const { buildEnhancedContextPackage } = await import("../../../graph/context-slicer.js");
  const pkg = await buildEnhancedContextPackage(
    graphClient,
    query,
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
  const rawTokenEstimate = estimateRawContextTokens(
    await resolveGraphStoreAfterIndex(config, graphClient),
    query,
    pkg.tokenEstimate
  );

  // Record cumulative token savings for ROI tracking
  try {
    const savingsPercent = calculateSavingsPercent(rawTokenEstimate, pkg.tokenEstimate);
    recordSavings(config, {
      timestamp: new Date().toISOString(),
      query,
      rawTokens: rawTokenEstimate,
      compressedTokens: pkg.tokenEstimate,
      savingsPercent,
      source: "preview_context",
    });
  } catch {
    // Savings tracking is best-effort; don't fail the preview if it errors
  }

  return {
    query,
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
    summary: pkg.summaryChannel,
    anchors: pkg.anchorChannel,
    tokenBudget: {
      maxContextTokens: config.graphPolicy.maxContextTokens,
      estimatedRawTokens: rawTokenEstimate,
      compressedTokens: pkg.tokenEstimate,
      estimatedSavingsPercent: calculateSavingsPercent(rawTokenEstimate, pkg.tokenEstimate),
      budgetUsedPercent: calculateBudgetUsedPercent(pkg.tokenEstimate, config.graphPolicy.maxContextTokens),
    },
  };
}

export async function indexGraph(rootDir?: string, configPath?: string): Promise<GraphIndexResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);
  const targetDir = rootDir || config.graphPolicy.workspaceRoot || process.cwd();

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
  });

  await maybeRunSemanticEnrichment(config, graphClient);

  return indexed;
}

/**
 * Incremental single-file indexing — for file-watcher / onSave hooks.
 *
 * @param filePath Absolute or relative path to the file to index
 * @param configPath Optional config path
 */
export async function indexFile(
  filePath: string,
  configPath?: string
): Promise<{
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
  skipped: boolean;
  reason?: string;
  path: string;
}> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();

  const absPath = filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)
    ? filePath
    : join(root, filePath);

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const result = await indexSingleFile(graphClient, root, absPath, indexOptions);
  return { ...result, path: absPath };
}

export async function rebuildGraph(rootDir?: string, configPath?: string): Promise<GraphRebuildResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);
  const targetDir = rootDir || config.graphPolicy.workspaceRoot || process.cwd();
  const storePath = resolveGraphStorePath(config);

  clearGraphIndexArtifacts(targetDir, storePath);

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
    forceReindex: true,
  });

  await maybeRunSemanticEnrichment(config, graphClient);

  return {
    ...indexed,
    cleared: true,
    storePath,
  };
}

export async function enrichSemanticsSilent(
  configPath?: string,
  options?: { batchSize?: number; sleepMs?: number; timeoutMs?: number }
): Promise<{ enrichedCount: number }> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  applyEnrichmentProviderEnv(config);
  const graphClient = createGraphClient(config);
  const enrichPolicy = config.graphPolicy.semanticEnrichment;
  const enricherOptions: EnricherOptions = {};
  const batchSize = options?.batchSize ?? enrichPolicy?.batchSize;
  if (batchSize !== undefined) {
    enricherOptions.batchSize = batchSize;
  }
  const sleepMs = options?.sleepMs ?? enrichPolicy?.sleepMs;
  if (sleepMs !== undefined) {
    enricherOptions.sleepMs = sleepMs;
  }
  const timeoutMs = options?.timeoutMs ?? enrichPolicy?.timeoutMs;
  if (timeoutMs !== undefined) {
    enricherOptions.timeoutMs = timeoutMs;
  }
  if (enrichPolicy?.model) {
    enricherOptions.model = enrichPolicy.model;
  }

  return enrichGraphSemanticsSilent(graphClient, enricherOptions);
}

export async function downloadOpenBmbModel(
  configPath?: string,
  options?: {
    model?: string;
    url?: string;
    sha256?: string;
    targetPath?: string;
    force?: boolean;
    onProgress?: (progress: ModelDownloadProgress) => void;
  }
): Promise<ModelDownloadResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);

  const model = options?.model ?? "minicpm5-1b";
  const defaultUrl = process.env.GRAPHFLOW_MINICPM_MODEL_URL;
  const url = options?.url ?? defaultUrl;

  const configuredPath = options?.targetPath ?? config.providers.openbmb?.modelPath;
  const fallbackPath = join(tmpdir(), "graphflow-models", `${model}.gguf`);
  const targetPath = configuredPath ?? fallbackPath;
  const force = options?.force ?? false;
  const expectedSha = options?.sha256 ?? process.env.GRAPHFLOW_MINICPM_MODEL_SHA256;
  const partialPath = `${targetPath}.part`;
  const lockPath = `${targetPath}.lock`;

  return withFileLock(lockPath, async () => {
    if (existsSync(targetPath) && !force) {
      const bytes = getFileSize(targetPath);
      const verified = expectedSha ? (await sha256File(targetPath)) === expectedSha.toLowerCase() : true;
      options?.onProgress?.({
        model,
        targetPath,
        downloadedBytes: bytes,
        totalBytes: bytes,
        resumed: false,
        percent: 100,
        stage: "skipped",
      });
      return {
        model,
        targetPath,
        bytes,
        skipped: true,
        verified,
      };
    }

    if (!url) {
      throw new Error("Model download URL is required. Set GRAPHFLOW_MINICPM_MODEL_URL or pass --url.");
    }

    mkdirSync(dirname(targetPath), { recursive: true });

    let partialSize = 0;
    if (existsSync(partialPath) && !force) {
      try {
        partialSize = getFileSize(partialPath);
      } catch {
        partialSize = 0;
      }
    }

    if (force) {
      rmSync(partialPath, { force: true });
      partialSize = 0;
    }

    options?.onProgress?.({
      model,
      targetPath,
      downloadedBytes: partialSize,
      resumed: partialSize > 0,
      stage: "starting",
    });

    const fetchInit: RequestInit = {};
    if (partialSize > 0) {
      fetchInit.headers = { range: `bytes=${partialSize}-` };
    }
    const response = await fetch(url, fetchInit);
    if (!response.ok) {
      throw new Error(`Model download failed: ${response.status} ${response.statusText}`);
    }

    const acceptsRange = response.status === 206;
    if (!acceptsRange && partialSize > 0) {
      rmSync(partialPath, { force: true });
      partialSize = 0;
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0
      ? partialSize + contentLength
      : undefined;

    const stream = response.body;
    if (!stream) {
      throw new Error("Model download failed: empty response body");
    }

    const reader = stream.getReader();
    const resumed = partialSize > 0 && acceptsRange;
    const writer = createWriteStream(partialPath, { flags: resumed ? "a" : "w" });
    let downloadedBytes = partialSize;
    let lastReportedBytes = -1;

    const emitProgress = (stage: ModelDownloadProgress["stage"]) => {
      if (downloadedBytes === lastReportedBytes && stage === "downloading") {
        return;
      }
      lastReportedBytes = downloadedBytes;
      const percent = totalBytes && totalBytes > 0
        ? Math.min(100, Number(((downloadedBytes / totalBytes) * 100).toFixed(1)))
        : undefined;
      options?.onProgress?.({
        model,
        targetPath,
        downloadedBytes,
        ...(totalBytes ? { totalBytes } : {}),
        resumed,
        ...(percent !== undefined ? { percent } : {}),
        stage,
      });
    };

    emitProgress("downloading");
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        const chunk = Buffer.from(value);
        await new Promise<void>((resolve, reject) => {
          writer.write(chunk, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        downloadedBytes += chunk.length;
        emitProgress("downloading");
      }
    }

    await new Promise<void>((resolve, reject) => {
      writer.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    renameSync(partialPath, targetPath);

    if (expectedSha) {
      options?.onProgress?.({
        model,
        targetPath,
        downloadedBytes,
        ...(totalBytes ? { totalBytes } : {}),
        resumed,
        percent: 100,
        stage: "verifying",
      });
      const actual = await sha256File(targetPath);
      if (actual !== expectedSha.toLowerCase()) {
        rmSync(targetPath, { force: true });
        throw new Error(`Model sha256 mismatch. expected=${expectedSha.toLowerCase()} actual=${actual}`);
      }
    }

    const finalBytes = getFileSize(targetPath);
    options?.onProgress?.({
      model,
      targetPath,
      downloadedBytes: finalBytes,
      totalBytes: finalBytes,
      resumed,
      percent: 100,
      stage: "completed",
    });
    return {
      model,
      targetPath,
      bytes: finalBytes,
      skipped: false,
      verified: Boolean(expectedSha),
      ...(resumed ? { resumed: true } : {}),
    };
  });
}

export async function inspectGraph(
  configPath?: string,
  options?: { nodeLimit?: number; edgeLimit?: number }
): Promise<GraphSnapshotResult> {
  const config = resolveConfig(configPath);
  const nodeLimit = Math.max(1, options?.nodeLimit ?? 96);
  const edgeLimit = Math.max(1, options?.edgeLimit ?? 160);
  const emptyTypeCount: Record<GraphNode["type"], number> = {
    File: 0,
    Symbol: 0,
    Module: 0,
    TaskRun: 0,
    Decision: 0,
    Skill: 0,
  };

  if (config.graphPolicy.transport === "mcp-http") {
    return {
      transport: config.graphPolicy.transport,
      storePath: resolveGraphStorePath(config),
      nodeCount: 0,
      edgeCount: 0,
      nodeTypeCount: emptyTypeCount,
      topRelations: [],
      sampleNodes: [],
      sampleEdges: [],
    };
  }

  let store = loadGraphStore(config);
  if (store.nodes.length === 0) {
    const graphClient = createGraphClient(config);
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
    store = await resolveGraphStoreAfterIndex(config, graphClient);
  }

  const relationCounts = new Map<GraphEdge["relation"], number>();
  for (const edge of store.edges) {
    relationCounts.set(edge.relation, (relationCounts.get(edge.relation) ?? 0) + 1);
  }

  const nodeTypeCount = { ...emptyTypeCount };
  for (const node of store.nodes) {
    nodeTypeCount[node.type] += 1;
  }

  return {
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    nodeCount: store.nodes.length,
    edgeCount: store.edges.length,
    nodeTypeCount,
    topRelations: Array.from(relationCounts.entries())
      .map(([relation, count]) => ({ relation, count }))
      .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation))
      .slice(0, 8),
    ...sampleGraphForSnapshot(store.nodes, store.edges, nodeLimit, edgeLimit),
  };
}

export async function getSkillInsights(configPath?: string, limit = 12): Promise<SkillInsightsResult> {
  const config = resolveConfig(configPath);
  const boundedLimit = Math.max(1, limit);

  if (config.graphPolicy.transport === "mcp-http") {
    return {
      source: "unavailable",
      transport: config.graphPolicy.transport,
      storePath: resolveGraphStorePath(config),
      skills: [],
    };
  }

  let store = loadGraphStore(config);
  if (store.nodes.length === 0) {
    const graphClient = createGraphClient(config);
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
    store = await resolveGraphStoreAfterIndex(config, graphClient);
  }

  const skills = store.nodes
    .filter((node) => node.type === "Skill")
    .map((node) => parseSkillInsight(node))
    .filter((state): state is SkillInsightItem => Boolean(state))
    .sort((a, b) => b.score - a.score || b.uses - a.uses || b.updatedAt - a.updatedAt)
    .slice(0, boundedLimit);

  return {
    source: "graph-store",
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    skills,
  };
}

export async function exportArtifact(
  configPath?: string,
  outputPath?: string,
  client?: GraphClient,
  options?: { compression?: "gzip" | "none" }
): Promise<{
  path: string;
  nodeCount: number;
  edgeCount: number;
  bytes: number;
  uncompressedBytes: number;
  sha256: string;
  compression: "none" | "gzip";
}> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = client ?? createGraphClient(config);
  const { exportGraphArtifact } = await import("../../../graph/artifact-manager.js");
  return exportGraphArtifact(config, outputPath, graphClient, options);
}

export async function importArtifact(
  configPath?: string,
  inputPath?: string
): Promise<{ path: string; nodeCount: number; edgeCount: number; imported: boolean; skipped: boolean; reason?: string }> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);
  const { importGraphArtifact } = await import("../../../graph/artifact-manager.js");
  return importGraphArtifact(config, graphClient, inputPath);
}

export function getTokenSavingsStats(configPath?: string): {
  totalRuns: number;
  totalRawTokens: number;
  totalCompressedTokens: number;
  totalSavedTokens: number;
  averageSavingsPercent: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  recentRecords: Array<{
    timestamp: string;
    query: string;
    rawTokens: number;
    compressedTokens: number;
    savingsPercent: number;
    source: string;
  }>;
} {
  const config = resolveConfig(configPath);
  return getSavingsStats(config);
}

export function resetTokenSavingsStats(configPath?: string): { path: string; reset: boolean } {
  const config = resolveConfig(configPath);
  return resetSavingsStats(config);
}

export function getMetrics(configPath?: string): {
  metrics: Record<string, number>;
  labels: Record<string, string>;
  text: string;
} {
  const config = resolveConfig(configPath);
  return collectMetrics(config);
}
