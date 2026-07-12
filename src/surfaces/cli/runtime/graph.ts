import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isUnsafeWorkspaceFallback } from "../../../config/discover-workspace.js";
import { resolveConfig } from "../../../config/resolve";
import { resolveGraphStorePath } from "../../../config/paths";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import type { GraphEdge, GraphNode } from "../../../core/types";
import { createGraphClient, type GraphClient } from "../../../graph/client-factory";
import {
  createContextRefillManager,
} from "../../../graph/context-slicer";
import { indexWorkspaceFiles, clearGraphIndexArtifacts, hasPendingGraphIndexWork, indexSingleFile } from "../../../graph/file-indexer";
import { GraphFileWatcher } from "../../../graph/file-watcher.js";
import { extractNodeSourcePath } from "../../../graph/graph-utils";
import { sampleGraphForSnapshot } from "../../../graph/snapshot-view.js";
import { getSavingsStats, resetSavingsStats, recordSavings } from "../../../graph/token-savings.js";
import { logger } from "../../../utils/logger.js";
import { buildEmbeddingOptions,
} from "./env.js";
import {
  calculateBudgetUsedPercent,
  calculateSavingsPercent,
  estimateRawContextTokens,
  loadGraphStore,
  parseSkillInsight,
  resolveGraphStoreAfterIndex,
} from "./helpers.js";
import type {
  ContextPreviewResult,
  ExpandAnchorResult,
  GraphIndexResult,
  GraphRebuildResult,
  GraphSnapshotResult,
  SkillInsightItem,
  SkillInsightsResult,
} from "./types.js";
import type { GraphFlowConfig } from "../../../config/schema";
import {
  buildQueryTranslateInstructions,
  buildQueryTranslateWorkItem,
  shouldDelegateQueryTranslation,
} from "../../../graph/query-translate.js";

function graphStoreNeedsIndexing(config: GraphFlowConfig): boolean {
  const storePath = resolveGraphStorePath(config);
  if (!existsSync(storePath)) {
    return true;
  }
  if (config.graphPolicy.transport === "sqlite") {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { nodes?: unknown[] };
    return !Array.isArray(parsed.nodes) || parsed.nodes.length === 0;
  } catch {
    return true;
  }
}

export async function previewContext(
  query: string,
  configPath?: string,
  rootDir?: string,
  englishQuery?: string
): Promise<ContextPreviewResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath), rootDir ? { rootDir } : undefined);
  const graphClient = createGraphClient(config);

  if (config.graphPolicy.autoIndexOnPreview) {
    const root = config.graphPolicy.workspaceRoot ?? process.cwd();
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    if (hasPendingGraphIndexWork(root, indexOptions) || graphStoreNeedsIndexing(config)) {
      await indexWorkspaceFiles(graphClient, root, {
        ...indexOptions,
      });
    }
  }

  const packageOptions: import("../../../graph/context-slicer").LayeredPackageOptions = {
    ...(config.graphPolicy.layerQuota ? { layerQuota: config.graphPolicy.layerQuota } : {}),
    ...buildEmbeddingOptions(config),
    workspaceRoot: config.graphPolicy.workspaceRoot ?? process.cwd(),
    ...(englishQuery?.trim() ? { englishQuery: englishQuery.trim() } : {}),
    // Persist HNSW index to disk for faster startup on large repos.
    ...(config.embeddingPolicy?.vectorStorePath
      ? { hnswIndexPath: config.embeddingPolicy.vectorStorePath.replace(/\.\w+$/, ".hnsw") }
      : {}),
  };

  const compressionPolicy = config.graphPolicy.compression;

  // Graph-structure compression is zero-cost; enabled by default unless explicitly disabled.
  packageOptions.enableGraphCompression = compressionPolicy?.enableGraphCompression !== false;

  // RepoMap overview fallback for tight budgets (opt-in).
  if (compressionPolicy?.enableRepoMapFallback === true) {
    packageOptions.enableRepoMapFallback = true;
  }

  // Adaptive budget: auto-enable for complex tasks unless explicitly disabled.
  const { triageTask } = await import("../../../core/triage.js");
  const taskMode = triageTask(query);
  const enableAdaptiveBudget =
    compressionPolicy?.enableAdaptiveBudget !== false &&
    (compressionPolicy?.enableAdaptiveBudget === true || taskMode === "complex");
  if (enableAdaptiveBudget) {
    packageOptions.taskMode = taskMode;
  }

  // Semantic compression (minicpm/economy LLM) is opt-in via config.
  // Note: compression-model module removed; semantic compression disabled.

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

  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
  const anchorCount = pkg.anchorChannel.length;
  const queryTranslationDelegation = shouldDelegateQueryTranslation(query, anchorCount, englishQuery)
    ? {
        agentWorkItems: [buildQueryTranslateWorkItem(query, workspaceRoot)],
        agentInstructions: buildQueryTranslateInstructions(query),
        agentMode: "delegated-llm" as const,
      }
    : undefined;

  return {
    query,
    ...(englishQuery?.trim() ? { englishQuery: englishQuery.trim() } : {}),
    summaryCount: pkg.summaryChannel.length,
    anchorCount,
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
    ...(queryTranslationDelegation ?? {}),
  };
}

export async function indexGraph(rootDir?: string, configPath?: string): Promise<GraphIndexResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath), rootDir ? { rootDir } : undefined);
  const graphClient = createGraphClient(config);
  const targetDir = config.graphPolicy.workspaceRoot ?? process.cwd();

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
  });

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
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath), rootDir ? { rootDir } : undefined);
  const graphClient = createGraphClient(config);
  const targetDir = config.graphPolicy.workspaceRoot ?? process.cwd();
  const storePath = resolveGraphStorePath(config);

  clearGraphIndexArtifacts(targetDir, storePath);

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
    forceReindex: true,
  });

  return {
    ...indexed,
    cleared: true,
    storePath,
  };
}

export async function inspectGraph(
  configPath?: string,
  options?: { nodeLimit?: number; edgeLimit?: number; rootDir?: string }
): Promise<GraphSnapshotResult> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
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
    ...sampleGraphForSnapshot(
      store.nodes,
      store.edges,
      nodeLimit,
      edgeLimit,
      config.graphPolicy.workspaceRoot ?? process.cwd()
    ),
  };
}

export async function getSkillInsights(
  configPath?: string,
  limit = 12,
  rootDir?: string
): Promise<SkillInsightsResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath), rootDir ? { rootDir } : undefined);
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
  const graphClient = client ?? createGraphClient(config);
  const { exportGraphArtifact } = await import("../../../graph/artifact-manager.js");
  return exportGraphArtifact(config, outputPath, graphClient, options);
}

export async function importArtifact(
  configPath?: string,
  inputPath?: string
): Promise<{ path: string; nodeCount: number; edgeCount: number; imported: boolean; skipped: boolean; reason?: string }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { importGraphArtifact } = await import("../../../graph/artifact-manager.js");
  return importGraphArtifact(config, graphClient, inputPath);
}

/**
 * 导出所有 Skill 类型节点为 JSON 技能包。
 *
 * @param configPath 可选配置路径
 * @param outputPath 输出文件路径（默认 graphflow-out/skills.json）
 */
export async function exportSkillPackageRuntime(
  configPath?: string,
  outputPath?: string
): Promise<{ path: string; skillCount: number; bytes: number }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { exportSkillPackage } = await import("../../../learning/skill-package.js");
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const targetPath = outputPath
    ? (outputPath.startsWith("/") || /^[A-Za-z]:/.test(outputPath)
      ? outputPath
      : join(root, outputPath))
    : join(root, "graphflow-out", "skills.json");
  return exportSkillPackage(graphClient, targetPath);
}

/**
 * 导入技能包，跳过已存在的技能。
 *
 * @param configPath 可选配置路径
 * @param inputPath 输入文件路径（默认 graphflow-out/skills.json）
 */
export async function importSkillPackageRuntime(
  configPath?: string,
  inputPath?: string
): Promise<{ path: string; imported: number; skipped: number; total: number }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { importSkillPackage } = await import("../../../learning/skill-package.js");
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const sourcePath = inputPath
    ? (inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)
      ? inputPath
      : join(root, inputPath))
    : join(root, "graphflow-out", "skills.json");
  return importSkillPackage(graphClient, sourcePath);
}

export function getTokenSavingsStats(configPath?: string, rootDir?: string): {
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
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath), rootDir ? { rootDir } : undefined);
  return getSavingsStats(config);
}

export function resetTokenSavingsStats(configPath?: string): { path: string; reset: boolean } {
  const config = resolveConfig(configPath);
  return resetSavingsStats(config);
}

/**
 * Expand a context anchor to its full content.
 *
 * Context anchors returned by `previewContext` are lightweight pointers
 * (id/type/layer). This function resolves an anchor id back to its full
 * GraphNode content and, for Symbol nodes, optionally reads the surrounding
 * source code lines from the original file.
 *
 * @param anchorId  The anchor id (e.g. "symbol:src/foo.ts:abc123")
 * @param configPath Optional config path
 * @param rootDir    Optional workspace root override
 */
export async function expandAnchor(
  anchorId: string,
  configPath?: string,
  rootDir?: string
): Promise<ExpandAnchorResult | undefined> {
  const baseConfig = resolveConfig(configPath);
  // Respect explicit rootDir override; otherwise keep the config's workspaceRoot
  const config = rootDir
    ? bindRuntimeWorkspaceRoot(baseConfig, { rootDir })
    : baseConfig;
  const graphClient = createGraphClient(config);

  if (!graphClient.getNodesByIds) {
    return undefined;
  }

  const nodes = await graphClient.getNodesByIds([anchorId]);
  const node = nodes.find((n) => n.id === anchorId);
  if (!node) {
    return undefined;
  }

  const sourcePath = extractNodeSourcePath(node);
  const sourceLine = typeof node.metadata?.line === "number" ? node.metadata.line : undefined;

  // For Symbol nodes, try to read the surrounding source code
  let sourceSnippet: string | undefined;
  if (sourcePath && sourceLine !== undefined) {
    const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
    const absPath = join(workspaceRoot, sourcePath);
    if (existsSync(absPath)) {
      try {
        const fileContent = readFileSync(absPath, "utf8");
        const lines = fileContent.split(/\r?\n/);
        // Read a window of lines around the symbol: 3 lines before to 20 lines after
        const startLine = Math.max(0, sourceLine - 4);
        const endLine = Math.min(lines.length, sourceLine + 20);
        const snippet = lines.slice(startLine, endLine).join("\n");
        sourceSnippet = snippet;
      } catch {
        // Ignore read errors — source file may not be accessible
      }
    }
  }

  return {
    anchorId: node.id,
    type: node.type,
    content: node.content,
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceLine !== undefined ? { sourceLine } : {}),
    ...(sourceSnippet ? { sourceSnippet } : {}),
    ...(node.metadata ? { metadata: node.metadata } : {}),
  };
}

/**
 * Start a file watcher for auto-indexing on save when `autoIndexOnSave` is enabled.
 *
 * @param config Resolved GraphFlow configuration
 * @param configPath Optional config path to pass through to incremental indexing
 * @returns The started watcher instance, or `null` if disabled
 */
export function startFileWatcherIfEnabled(
  config: GraphFlowConfig,
  configPath?: string
): GraphFileWatcher | null {
  if (!config.graphPolicy.autoIndexOnSave) {
    return null;
  }

  const rootDir = config.graphPolicy.workspaceRoot ?? process.cwd();
  // MCP/IDE often spawn with cwd=home; never watch the whole user profile.
  if (isUnsafeWorkspaceFallback(rootDir)) {
    logger.warn(
      { rootDir },
      "Skipping file watcher: workspace root is unsafe (home/AppData). Pass rootDir or set GRAPHFLOW_WORKSPACE_ROOT."
    );
    return null;
  }

  const watcher = new GraphFileWatcher(rootDir, configPath);

  watcher.onChange((files) => {
    for (const file of files) {
      void indexFile(file, configPath).catch(() => {
        // Incremental index failures are best-effort; don’t crash the watcher
      });
    }
  });

  watcher.start();
  return watcher;
}
