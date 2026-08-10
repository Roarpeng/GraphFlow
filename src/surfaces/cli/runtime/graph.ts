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
import {
  isAutoCaptureEnabled,
  readJournalEntries,
  resolveSessionJournalPath,
} from "../../../hooks/auto-capture.js";
import type { SkillOutcomeKind } from "../../../learning/skill-types.js";
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

function emptySkillOutcomeKindCounts(): Record<SkillOutcomeKind, number> {
  return { proven: 0, correctable: 0, "anti-pattern": 0, noise: 0 };
}

/** Read outcomeKind from a Skill node content blob (atomic or composite). */
function readSkillOutcomeKind(content: string): SkillOutcomeKind | undefined {
  try {
    const parsed = JSON.parse(content) as { outcomeKind?: unknown };
    if (
      parsed.outcomeKind === "proven" ||
      parsed.outcomeKind === "correctable" ||
      parsed.outcomeKind === "anti-pattern" ||
      parsed.outcomeKind === "noise"
    ) {
      return parsed.outcomeKind;
    }
  } catch {
    // ignore malformed skill payloads
  }
  return undefined;
}

function graphStoreNeedsIndexing(config: GraphFlowConfig): boolean {
  const storePath = resolveGraphStorePath(config);
  if (config.graphPolicy.transport === "auto" && !existsSync(storePath)) {
    // Auto transport may have fallen back to the JSON store on this machine.
    const fallbackPath = storePath.replace(/\.sqlite$/i, ".json");
    if (existsSync(fallbackPath)) {
      try {
        const parsed = JSON.parse(readFileSync(fallbackPath, "utf8")) as { nodes?: unknown[] };
        return !Array.isArray(parsed.nodes) || parsed.nodes.length === 0;
      } catch {
        return true;
      }
    }
    return true;
  }
  if (!existsSync(storePath)) {
    return true;
  }
  if (config.graphPolicy.transport === "sqlite" || config.graphPolicy.transport === "auto") {
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
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();

  const { getCachedContext, cacheContextResult } = await import("../../../graph/context-cache.js");
  const cached = getCachedContext(query, workspaceRoot);
  if (cached) {
    return cached;
  }

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

  const anchorCount = pkg.anchorChannel.length;
  const queryTranslationDelegation = shouldDelegateQueryTranslation(query, anchorCount, englishQuery)
    ? {
        agentWorkItems: [buildQueryTranslateWorkItem(query, workspaceRoot)],
        agentInstructions: buildQueryTranslateInstructions(query),
        agentMode: "delegated-llm" as const,
      }
    : undefined;

  const result: ContextPreviewResult = {
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

  cacheContextResult(query, workspaceRoot, result);

  return result;
}

export async function indexGraph(
  rootDir?: string,
  configPath?: string,
  options?: { onProgress?: (processed: number, total: number) => void }
): Promise<GraphIndexResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath), rootDir ? { rootDir } : undefined);
  const graphClient = createGraphClient(config);
  const targetDir = config.graphPolicy.workspaceRoot ?? process.cwd();

  const { invalidateContextCache } = await import("../../../graph/context-cache.js");
  invalidateContextCache(targetDir);

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
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

export async function rebuildGraph(
  rootDir?: string,
  configPath?: string,
  options?: { onProgress?: (processed: number, total: number) => void }
): Promise<GraphRebuildResult> {
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
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
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
    Concept: 0,
    Requirement: 0,
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
): Promise<SkillInsightsResult> {  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath), rootDir ? { rootDir } : undefined);
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

export interface FlywheelReport {
  transport: string;
  storePath: string;
  /**
   * P0 flywheel auto-capture health — whether pending episodes are written
   * automatically on run/context completion (`GRAPHFLOW_AUTO_CAPTURE`).
   */
  autoCaptureEnabled: boolean;
  /** Session journal used by hooks/backfill to resolve pending episodeIds. */
  sessionJournal: {
    path: string;
    exists: boolean;
    /** Count of pending-episode journal entries awaiting outcome backfill. */
    pendingCount: number;
  };
  skills: {
    total: number;
    positive: number;
    neutral: number;
    negative: number;
    /** P0-2 four-class skill lifecycle distribution (hidden skills excluded). */
    byOutcomeKind: Record<SkillOutcomeKind, number>;
    /** Most-used skills — what the flywheel actually injects most often. */
    topUsed: Array<{ name: string; score: number; uses: number }>;
  };
  episodes: {
    total: number;
    pass: number;
    fail: number;
    pending: number;
    /** Episodes carrying extracted lessons (flywheel raw material). */
    withLessons: number;
    /** P1 — drift classification counts across episodes that reported deviation. */
    deviations: {
      misreadRequirement: number;
      scopeCreep: number;
      techDrift: number;
      none: number;
    };
  };
  /** Decision nodes that are not episodes (Six Hats / plan insights). */
  insightDecisions: number;
  /** P0/P4 — goal anchors: active requirement anchors + superseded versions. */
  goals: {
    active: number;
    supersededVersions: number;
  };
  /**
   * MEMORY ATTRIBUTION — makes episodic memory observable: how much stored
   * memory could contribute to task rescue, how confident the outcome
   * distribution is, the freshest evidence chain, and why work deviated.
   * Additive-only: existing consumers (VS Code panel, MCP diagnose) keep
   * reading the fields above unchanged.
   */
  memoryAttribution: {
    /**
     * Total episode recall hits across recent runs. Episode records do not
     * yet persist per-run recall telemetry, so this falls back to episodes
     * carrying lessons — the rescue material the v1.9 A/B benchmark proved
     * is what saves tasks.
     */
    memoryHits: number;
    /** Episodes flagged staleGoal by goal versioning (the requirement moved
     *  under them, so their plan context must not be trusted as-is). */
    staleEpisodes: number;
    /** Pass/fail/pending distribution as percentages of all episodes. */
    confidence: {
      passPercent: number;
      failPercent: number;
      pendingPercent: number;
    };
    /** Top 3 most-recent episodes — the evidence chain: what memory holds
     *  that could inform the next run (task truncated, outcome, lesson count). */
    topContributingMemories: Array<{
      id: string;
      task: string;
      outcome: string;
      lessonsCount: number;
      updatedAt: number;
    }>;
    /** Counts per deviation category across stored episode records. */
    deviationBreakdown: {
      none: number;
      misreadRequirement: number;
      scopeCreep: number;
      techDrift: number;
    };
  };
  /**
   * P0 Experience-layer evidence — conversion / coverage rates and a short
   * consolidation tip. Additive-only for diagnose / skill report consumers.
   */
  experience: {
    /**
     * Skills per resolved episode: `skills.total / max(pass + fail, 1)`,
     * capped at 1.0 so the metric reads as a 0–1 conversion rate (many skills
     * per episode still count as “converted”). Denominator is pass+fail
     * (not withLessons) because only resolved outcomes feed the flywheel.
     */
    episodeToSkillConversionRate: number;
    /** `withLessons / max(episodes.total, 1)` — how often episodes carry extractable lessons. */
    lessonsCoverageRate: number;
    antiPatternCount: number;
    provenSkillCount: number;
    /** Short human tip when conversion is low or pending share is high. */
    consolidationHint: string;
  };
}

/**
 * Flywheel contribution report: makes the learning loop observable — how many
 * skills exist, their health distribution, which get used, and how episodes
 * (pass/fail/pending + lessons) accumulate. Read-only; never triggers indexing.
 */
export function getFlywheelReport(configPath?: string, rootDir?: string): FlywheelReport {
  const resolved = resolveConfig(configPath);
  // Preserve config/project workspaceRoot when rootDir is omitted; a bare
  // bindRuntimeWorkspaceRoot(resolved) re-discovers from cwd and drops the
  // explicit graphPolicy.workspaceRoot that resolveConfig already bound.
  const config = bindRuntimeWorkspaceRoot(
    resolved,
    rootDir
      ? { rootDir }
      : resolved.graphPolicy.workspaceRoot
        ? { projectWorkspaceRoot: resolved.graphPolicy.workspaceRoot }
        : undefined
  );
  const store = loadGraphStore(config);
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
  const journalPath = resolveSessionJournalPath(workspaceRoot);
  const journalExists = existsSync(journalPath);
  const journalPendingCount = journalExists ? readJournalEntries(journalPath).length : 0;

  const byOutcomeKind = emptySkillOutcomeKindCounts();
  const skillItems: Array<NonNullable<ReturnType<typeof parseSkillInsight>>> = [];
  for (const node of store.nodes) {
    if (node.type !== "Skill") continue;
    const item = parseSkillInsight(node);
    if (!item) continue;
    skillItems.push(item);
    const kind = readSkillOutcomeKind(node.content);
    if (kind) {
      byOutcomeKind[kind] += 1;
    }
  }

  const topUsed = [...skillItems]
    .sort((a, b) => b.uses - a.uses || b.score - a.score)
    .slice(0, 5)
    .map((item) => ({ name: item.name, score: item.score, uses: item.uses }));

  let pass = 0;
  let fail = 0;
  let pending = 0;
  let withLessons = 0;
  let episodeCount = 0;
  let insightDecisions = 0;
  const deviations = { misreadRequirement: 0, scopeCreep: 0, techDrift: 0, none: 0 };
  let goalsActive = 0;
  let goalsSuperseded = 0;
  const episodes: Array<{
    id: string;
    task: string;
    outcome: string;
    lessonsCount: number;
    updatedAt: number;
    stale: boolean;
    deviation?: string;
  }> = [];
  for (const node of store.nodes) {
    if (node.type !== "Decision") continue;
    const kind = typeof node.metadata?.kind === "string" ? node.metadata.kind : undefined;
    if (kind === "goal") {
      if (node.metadata?.status === "superseded") goalsSuperseded += 1;
      else goalsActive += 1;
      continue;
    }
    if (kind !== "episode") {
      insightDecisions += 1;
      continue;
    }
    episodeCount += 1;
    try {
      const record = JSON.parse(
        typeof node.metadata?.record === "string" ? node.metadata.record : "{}"
      ) as {
        outcome?: string;
        lessons?: unknown[];
        deviation?: string;
        task?: string;
        updatedAt?: number;
        id?: string;
      };
      if (record.outcome === "pass") pass += 1;
      else if (record.outcome === "fail") fail += 1;
      else pending += 1;
      if (Array.isArray(record.lessons) && record.lessons.length > 0) {
        withLessons += 1;
      }
      if (record.deviation === "misread-requirement") deviations.misreadRequirement += 1;
      else if (record.deviation === "scope-creep") deviations.scopeCreep += 1;
      else if (record.deviation === "tech-drift") deviations.techDrift += 1;
      else if (record.deviation === "none") deviations.none += 1;
      episodes.push({
        id: typeof record.id === "string" ? record.id : node.id,
        task: typeof record.task === "string" ? record.task : node.content,
        outcome: typeof record.outcome === "string" ? record.outcome : "pending",
        lessonsCount: Array.isArray(record.lessons) ? record.lessons.length : 0,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
        stale: node.metadata?.staleGoal !== undefined,
        ...(typeof record.deviation === "string" ? { deviation: record.deviation } : {}),
      });
    } catch {
      pending += 1;
    }
  }

  const memoryHits = episodes.filter((e) => e.lessonsCount > 0).length;
  const staleEpisodes = episodes.filter((e) => e.stale).length;
  const topContributingMemories = [...episodes]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map((e) => ({
      id: e.id,
      task: e.task.length > 60 ? `${e.task.slice(0, 57)}...` : e.task,
      outcome: e.outcome,
      lessonsCount: e.lessonsCount,
      updatedAt: e.updatedAt,
    }));

  const resolvedEpisodes = Math.max(pass + fail, 1);
  const episodeToSkillConversionRate = Math.min(1, skillItems.length / resolvedEpisodes);
  const lessonsCoverageRate = withLessons / Math.max(episodeCount, 1);
  const pendingShare = episodeCount === 0 ? 0 : pending / episodeCount;
  let consolidationHint = "Experience flywheel looks healthy.";
  if (episodeToSkillConversionRate < 0.2 && pass + fail > 0) {
    consolidationHint =
      "Low skill conversion — report outcomes with lessons so episodes crystallize into skills.";
  } else if (pendingShare >= 0.5 && episodeCount > 0) {
    consolidationHint =
      "High pending episode share — call graphflow_report_outcome to close the flywheel loop.";
  } else if (byOutcomeKind["anti-pattern"] > byOutcomeKind.proven && skillItems.length > 0) {
    consolidationHint =
      "Anti-patterns outnumber proven skills — review consolidation / prune noise before trusting hints.";
  } else if (lessonsCoverageRate < 0.25 && episodeCount > 0) {
    consolidationHint =
      "Few episodes carry lessons — attach lessons on outcome report to grow Experience.";
  }

  return {
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    autoCaptureEnabled: isAutoCaptureEnabled(),
    sessionJournal: {
      path: journalPath,
      exists: journalExists,
      pendingCount: journalPendingCount,
    },
    skills: {
      total: skillItems.length,
      positive: skillItems.filter((s) => s.score > 0).length,
      neutral: skillItems.filter((s) => s.score === 0).length,
      negative: skillItems.filter((s) => s.score < 0).length,
      byOutcomeKind,
      topUsed,
    },
    episodes: {
      total: episodeCount,
      pass,
      fail,
      pending,
      withLessons,
      deviations,
    },
    insightDecisions,
    goals: {
      active: goalsActive,
      supersededVersions: goalsSuperseded,
    },
    memoryAttribution: {
      memoryHits,
      staleEpisodes,
      confidence: {
        passPercent: episodeCount === 0 ? 0 : Math.round((pass / episodeCount) * 100),
        failPercent: episodeCount === 0 ? 0 : Math.round((fail / episodeCount) * 100),
        pendingPercent: episodeCount === 0 ? 0 : Math.round((pending / episodeCount) * 100),
      },
      topContributingMemories,
      deviationBreakdown: {
        none: deviations.none,
        misreadRequirement: deviations.misreadRequirement,
        scopeCreep: deviations.scopeCreep,
        techDrift: deviations.techDrift,
      },
    },
    experience: {
      episodeToSkillConversionRate,
      lessonsCoverageRate,
      antiPatternCount: byOutcomeKind["anti-pattern"],
      provenSkillCount: byOutcomeKind.proven,
      consolidationHint,
    },
  };
}

export async function exportArtifact(
  configPath?: string,
  outputPath?: string,
  client?: GraphClient,
  options?: { compression?: "gzip" | "none"; includeEpisodes?: boolean }
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

/** Export a human-readable Markdown experience-memory pack (skills + episodes). */
export async function exportExperienceMemory(
  configPath?: string,
  outputDir?: string
): Promise<{
  path: string;
  files: string[];
  skillCount: number;
  episodeCount: number;
}> {
  const config = resolveConfig(configPath);
  const { exportExperienceMemoryPack } = await import("../../../graph/memory-pack.js");
  return exportExperienceMemoryPack(config, outputDir);
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
  outputPath?: string,
  opts?: { goldenQueries?: string[] }
): Promise<{ path: string; skillCount: number; bytes: number; goldenQueries?: number }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { exportSkillPackage } = await import("../../../learning/skill-package.js");
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const targetPath = outputPath
    ? (outputPath.startsWith("/") || /^[A-Za-z]:/.test(outputPath)
      ? outputPath
      : join(root, outputPath))
    : join(root, "graphflow-out", "skills.json");
  return exportSkillPackage(graphClient, targetPath, opts?.goldenQueries ? { goldenQueries: opts.goldenQueries } : undefined);
}

/**
 * 导入技能包（双向 MERGE：per-skill-id union，updatedAt 较新者胜，
 * 并列保留本地，仅本地技能保留；opts.force 恢复覆盖语义）。
 * 技能包携带 goldenQueries 时合并进本地集合并写入
 * `.graphflow/team-golden.json` 旁车文件。
 *
 * @param configPath 可选配置路径
 * @param inputPath 输入文件路径（默认 graphflow-out/skills.json）
 * @param opts 导入选项（force / goldenPath）
 */
export async function importSkillPackageRuntime(
  configPath?: string,
  inputPath?: string,
  opts?: { force?: boolean; goldenPath?: string }
): Promise<{
  path: string;
  imported: number;
  skipped: number;
  updated: number;
  total: number;
  goldenPath?: string;
  goldenQueries?: number;
}> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { importSkillPackage } = await import("../../../learning/skill-package.js");
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const sourcePath = inputPath
    ? (inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)
      ? inputPath
      : join(root, inputPath))
    : join(root, "graphflow-out", "skills.json");
  const goldenPath = opts?.goldenPath ?? join(root, ".graphflow", "team-golden.json");
  return importSkillPackage(graphClient, sourcePath, { force: opts?.force ?? false, goldenPath });
}

/**
 * 加载团队 golden 检索基准查询：
 * 优先从仓库内的 retrieval-golden 测试导出（开发环境），
 * 失败（如安装包环境无 tests/ 目录）时回退到本地 `.graphflow/team-golden.json` 旁车文件。
 */
async function loadCanonicalGoldenQueries(root: string): Promise<string[]> {
  try {
    // 动态 import 避免生产构建解析 tests/（tsconfig exclude）；非字面量说明符
    const testFile = "retrieval-golden.test";
    const specifier = `../../../../tests/${testFile}.ts`;
    const mod = (await import(specifier)) as {
      GOLDEN_SET?: ReadonlyArray<{ query: string }>;
    };
    const queries =
      mod.GOLDEN_SET?.map((entry) => entry.query).filter(
        (q): q is string => typeof q === "string"
      ) ?? [];
    if (queries.length > 0) {
      return queries;
    }
  } catch {
    // 非仓库环境：tests/ 不存在 → 回退旁车文件
  }
  try {
    const sidecar = join(root, ".graphflow", "team-golden.json");
    if (existsSync(sidecar)) {
      const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((q): q is string => typeof q === "string");
      }
    }
  } catch {
    // 旁车文件缺失/损坏 → 无 golden 查询
  }
  return [];
}

/**
 * Git-based team skill sharing.
 *
 * Exports/imports the skill package at a canonical, committable location:
 * `<workspace>/.graphflow/skills/team-skills.json`. Teams commit this file so
 * every member's agents share the same accumulated project experience.
 *
 * 冲突策略（import）：双向 MERGE —— per-skill-id union；同 id 冲突时
 * `updatedAt` 较新者胜、并列保留本地；仅本地/仅包中技能均保留；
 * `--force` 恢复覆盖语义。golden 查询随包往返，导入时合并（本地优先、
 * 按文本去重）写入 `.graphflow/team-golden.json` 旁车文件。
 *
 * @param configPath 可选配置路径
 * @param direction "export"（本地图 → 团队文件）或 "import"（团队文件 → 本地图）
 * @param customPath 覆盖默认团队技能包路径
 * @param opts 同步选项（force：import 时恢复覆盖语义）
 */
export async function syncSkillPackageRuntime(
  configPath: string | undefined,
  direction: "export" | "import",
  customPath?: string,
  opts?: { force?: boolean }
): Promise<
  | { direction: "export"; path: string; skillCount: number; bytes: number; goldenQueries?: number }
  | {
      direction: "import";
      path: string;
      imported: number;
      skipped: number;
      updated: number;
      total: number;
      goldenPath?: string;
      goldenQueries?: number;
    }
> {
  const config = resolveConfig(configPath);
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const teamPath = customPath
    ? (customPath.startsWith("/") || /^[A-Za-z]:/.test(customPath)
      ? customPath
      : join(root, customPath))
    : join(root, ".graphflow", "skills", "team-skills.json");

  if (direction === "export") {
    // 导出时打包团队 golden 检索基准（canonical 查询列表）
    const goldenQueries = await loadCanonicalGoldenQueries(root);
    const result = await exportSkillPackageRuntime(configPath, teamPath, { goldenQueries });
    return { direction: "export", ...result };
  }
  const result = await importSkillPackageRuntime(configPath, teamPath, {
    force: opts?.force ?? false,
  });
  return { direction: "import", ...result };
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
