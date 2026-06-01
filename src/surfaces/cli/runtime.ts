import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { brainstormTask } from "../../agents/brainstormer";
import { planTasks } from "../../agents/planner";
import { loadConfig, validateConfig } from "../../config/loader";
import { triageTask } from "../../core/triage";
import type { GraphEdge, GraphNode } from "../../core/types";
import type { GraphFlowConfig } from "../../config/schema";
import { orchestrate, type OrchestrateOptions } from "../../core/orchestrator";
import { createGraphClient, type GraphClient } from "../../graph/client-factory";
import { GraphifySqliteClient } from "../../graph/sqlite-client";
import { indexWorkspaceFiles } from "../../graph/file-indexer";
import {
  buildLayeredContextPackage,
  createContextRefillManager,
} from "../../graph/context-slicer";
import { appendFeedbackEvent, runNightlyLearning } from "../../learning/nightly-trainer";
import { resolveModelForRole, resolveModelWithFallback } from "../../routing/model-router";
import { buildFallbackChain, buildProviderHealthMap } from "../../routing/provider-health";
import type { TaskStatus } from "../../core/types";

export function getDefaultConfig(): GraphFlowConfig {
  return validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
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
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      canaryRatio: 10,
      exportPath: "tmp/learning-dataset.jsonl",
      eventsPath: "tmp/learning-events.jsonl",
      summaryPath: "tmp/learning-summary.json",
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
  });
}

export function resolveConfig(path = "graphflow.config.json"): GraphFlowConfig {
  if (existsSync(path)) {
    return loadConfig(path);
  }

  return getDefaultConfig();
}

export interface ContextPreviewResult {
  query: string;
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
  summary: string[];
  anchors: Array<{ id: string; type: GraphNode["type"]; layer: "L1" | "L2" | "L3" }>;
  tokenBudget: {
    maxContextTokens: number;
    estimatedRawTokens: number;
    compressedTokens: number;
    estimatedSavingsPercent: number;
    budgetUsedPercent: number;
  };
}

export interface GraphFlowSettings {
  configPath: string;
  provider: string;
  smartModel: string;
  economyModel: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  maxContextTokens: number;
  layerQuota: { l1: number; l2: number; l3: number };
  enableNearLosslessMode: boolean;
  autoIndexOnPreview: boolean;
  autoIndexOnRun: boolean;
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  graphStorePath: string;
}

export type GraphFlowSettingsInput = Omit<GraphFlowSettings, "configPath">;

export function getGraphFlowSettings(configPath = "graphflow.config.json"): GraphFlowSettings {
  const config = resolveConfig(configPath);
  const provider = config.tiers.smart.provider;
  const rawConfig = readRawConfig(configPath);
  const providerConfig = config.providers[provider] ?? {};
  const rawProviderConfig = rawConfig?.providers?.[provider] ?? {};
  const apiKeyEnvVar = parseEnvPlaceholder(rawProviderConfig.apiKey ?? providerConfig.apiKey);

  return {
    configPath,
    provider,
    smartModel: config.tiers.smart.model,
    economyModel: config.tiers.economy.model,
    ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
    ...(rawProviderConfig.baseUrl || providerConfig.baseUrl
      ? { baseUrl: rawProviderConfig.baseUrl ?? providerConfig.baseUrl }
      : {}),
    maxContextTokens: config.graphPolicy.maxContextTokens,
    layerQuota: config.graphPolicy.layerQuota ?? { l1: 6, l2: 4, l3: 3 },
    enableNearLosslessMode: config.graphPolicy.enableNearLosslessMode ?? false,
    autoIndexOnPreview: config.graphPolicy.autoIndexOnPreview ?? true,
    autoIndexOnRun: config.graphPolicy.autoIndexOnRun ?? true,
    transport: config.graphPolicy.transport,
    graphStorePath: config.graphPolicy.graphStorePath ?? "tmp/graphflow-graph.json",
  };
}

export function saveGraphFlowSettings(
  settings: GraphFlowSettingsInput,
  configPath = "graphflow.config.json"
): GraphFlowSettings {
  const current = resolveConfig(configPath);
  const providerConfig = {
    ...(settings.apiKeyEnvVar ? { apiKey: `\${${settings.apiKeyEnvVar}}` } : {}),
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
  };
  const updated = validateConfig({
    ...current,
    providers: {
      ...current.providers,
      [settings.provider]: providerConfig,
    },
    tiers: {
      smart: { provider: settings.provider, model: settings.smartModel },
      economy: { provider: settings.provider, model: settings.economyModel },
    },
    graphPolicy: {
      ...current.graphPolicy,
      enableNearLosslessMode: settings.enableNearLosslessMode,
      autoIndexOnPreview: settings.autoIndexOnPreview,
      autoIndexOnRun: settings.autoIndexOnRun,
      transport: settings.transport,
      graphStorePath: settings.graphStorePath,
      maxContextTokens: Math.max(1, Math.floor(settings.maxContextTokens)),
      layerQuota: {
        l1: Math.max(0, Math.floor(settings.layerQuota.l1)),
        l2: Math.max(0, Math.floor(settings.layerQuota.l2)),
        l3: Math.max(0, Math.floor(settings.layerQuota.l3)),
      },
    },
  });

  const dir = dirname(configPath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return getGraphFlowSettings(configPath);
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
  const rawTokenEstimate = estimateRawContextTokens(
    await resolveGraphStoreAfterIndex(config, graphClient),
    query,
    pkg.tokenEstimate
  );

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

export interface GraphIndexResult {
  indexedFiles: number;
  indexedSymbols: number;
}

export interface GraphSnapshotResult {
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  storePath?: string;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCount: Record<GraphNode["type"], number>;
  topRelations: Array<{ relation: GraphEdge["relation"]; count: number }>;
  sampleNodes: Array<{ id: string; type: GraphNode["type"]; contentPreview: string }>;
  sampleEdges: Array<{ from: string; relation: GraphEdge["relation"]; to: string }>;
}

export interface SkillInsightItem {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
}

export interface SkillInsightsResult {
  source: "graph-store" | "unavailable";
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  storePath?: string;
  skills: SkillInsightItem[];
}

export interface RunTaskSummary {
  status: TaskStatus;
  attempts: number;
  feedback: string;
}

export interface RoutingDiagnosisResult {
  dynamicRouting: boolean;
  health: Record<"openai" | "anthropic" | "bailian" | "doubao" | "openbmb", boolean>;
  priority: string[];
  planner: {
    provider: string;
    model: string;
    fallbackApplied: boolean;
  };
  worker: {
    provider: string;
    model: string;
    fallbackApplied: boolean;
  };
  validator: {
    provider: string;
    model: string;
    fallbackApplied: boolean;
  };
}

export interface LearningNightlyResult {
  events: number;
  passRate: number;
  avgTokens: number;
  canary: "allow" | "block";
  reason: string;
  dataset: string;
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

export async function inspectGraph(
  configPath?: string,
  options?: { nodeLimit?: number; edgeLimit?: number }
): Promise<GraphSnapshotResult> {
  const config = resolveConfig(configPath);
  const nodeLimit = Math.max(1, options?.nodeLimit ?? 24);
  const edgeLimit = Math.max(1, options?.edgeLimit ?? 36);
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
      ...(config.graphPolicy.graphStorePath ? { storePath: config.graphPolicy.graphStorePath } : {}),
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
    ...(config.graphPolicy.graphStorePath ? { storePath: config.graphPolicy.graphStorePath } : {}),
    nodeCount: store.nodes.length,
    edgeCount: store.edges.length,
    nodeTypeCount,
    topRelations: Array.from(relationCounts.entries())
      .map(([relation, count]) => ({ relation, count }))
      .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation))
      .slice(0, 8),
    sampleNodes: store.nodes.slice(0, nodeLimit).map((node) => ({
      id: node.id,
      type: node.type,
      contentPreview: compactPreview(node.content, 96),
    })),
    sampleEdges: store.edges.slice(0, edgeLimit).map((edge) => ({
      from: edge.from,
      relation: edge.relation,
      to: edge.to,
    })),
  };
}

export async function getSkillInsights(configPath?: string, limit = 12): Promise<SkillInsightsResult> {
  const config = resolveConfig(configPath);
  const boundedLimit = Math.max(1, limit);

  if (config.graphPolicy.transport === "mcp-http") {
    return {
      source: "unavailable",
      transport: config.graphPolicy.transport,
      ...(config.graphPolicy.graphStorePath ? { storePath: config.graphPolicy.graphStorePath } : {}),
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
    ...(config.graphPolicy.graphStorePath ? { storePath: config.graphPolicy.graphStorePath } : {}),
    skills,
  };
}

export async function runTaskResult(task: string, configPath?: string): Promise<RunTaskSummary> {
  const config = resolveConfig(configPath);
  const eventsPath = config.learningPolicy.eventsPath ?? "tmp/learning-events.jsonl";

  try {
    const graphClient = createGraphClient(config);
    if (config.graphPolicy.autoIndexOnRun) {
      const indexOptions = config.graphPolicy.includeExtensions
        ? { includeExtensions: config.graphPolicy.includeExtensions }
        : undefined;
      await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
        ...indexOptions,
      });
    }

    const orchestrateOptions: OrchestrateOptions = {
      graphClient,
      enableAutoGraphSync: config.graphPolicy.enableAutoBuild,
      maxContextTokens: config.graphPolicy.maxContextTokens,
      enableLlmTriage: config.tiers.smart.provider === "openbmb" || config.tiers.economy.provider === "openbmb",
      ...(config.skillPolicy?.enableSkillFlywheel
        ? {
            enableSkillFlywheel: true,
            ...(config.skillPolicy.maxSkillHints !== undefined
              ? { skillHintsLimit: config.skillPolicy.maxSkillHints }
              : {}),
          }
        : { enableSkillFlywheel: false }),
      ...(config.routingPolicy?.enableDynamicRouting
        ? {
            providerHealth: buildProviderHealthMap(config),
            providerFallbackChain: buildFallbackChain(config),
          }
        : {}),
      ...(config.graphPolicy.enableNearLosslessMode !== undefined
        ? { enableNearLosslessMode: config.graphPolicy.enableNearLosslessMode }
        : {}),
      ...(config.graphPolicy.layerQuota ? { layerQuota: config.graphPolicy.layerQuota } : {}),
    };

    const result = await orchestrate({ task }, orchestrateOptions);

    appendFeedbackEvent(eventsPath, {
      query: task,
      passed: result.status === "COMPLETED",
      tokenCost: extractTokenCost(result.feedback),
      retries: Math.max(0, result.attempts - 1),
    });

    return {
      status: result.status,
      attempts: result.attempts,
      feedback: result.feedback,
    };
  } catch (error) {
    appendFeedbackEvent(eventsPath, {
      query: task,
      passed: false,
      tokenCost: 0,
      retries: 0,
    });
    throw error;
  }
}

export async function runTask(task: string, configPath?: string): Promise<string> {
  const result = await runTaskResult(task, configPath);
  return `status=${result.status}; attempts=${result.attempts}; feedback=${result.feedback}`;
}

export function diagnoseRoutingResult(configPath?: string): RoutingDiagnosisResult {
  const config = resolveConfig(configPath);
  const health = buildProviderHealthMap(config);
  const chain = buildFallbackChain(config);

  const resolve = (role: "planner" | "worker" | "validator") => {
    if (!config.routingPolicy?.enableDynamicRouting) {
      return resolveModelForRole(role);
    }

    return resolveModelWithFallback(role, health, chain);
  };

  const planner = resolve("planner");
  const worker = resolve("worker");
  const validator = resolve("validator");

  return {
    dynamicRouting: config.routingPolicy?.enableDynamicRouting ?? false,
    health,
    priority: chain,
    planner: {
      provider: planner.provider,
      model: planner.model,
      fallbackApplied: planner.fallbackApplied,
    },
    worker: {
      provider: worker.provider,
      model: worker.model,
      fallbackApplied: worker.fallbackApplied,
    },
    validator: {
      provider: validator.provider,
      model: validator.model,
      fallbackApplied: validator.fallbackApplied,
    },
  };
}

export function diagnoseRouting(configPath?: string): string {
  const result = diagnoseRoutingResult(configPath);
  return [
    `dynamicRouting=${result.dynamicRouting ? "on" : "off"}`,
    `health=openai:${result.health.openai},anthropic:${result.health.anthropic},bailian:${result.health.bailian},doubao:${result.health.doubao},openbmb:${result.health.openbmb}`,
    `priority=${result.priority.join(",")}`,
    `planner=${result.planner.provider}/${result.planner.model}${result.planner.fallbackApplied ? ":fallback" : ""}`,
    `worker=${result.worker.provider}/${result.worker.model}${result.worker.fallbackApplied ? ":fallback" : ""}`,
    `validator=${result.validator.provider}/${result.validator.model}${result.validator.fallbackApplied ? ":fallback" : ""}`,
  ].join("; ");
}

export function runLearningNightlyResult(configPath?: string): LearningNightlyResult {
  const config = resolveConfig(configPath);
  const summary = runNightlyLearning(config);

  return {
    events: summary.totalEvents,
    passRate: summary.passRate,
    avgTokens: summary.averageTokenCost,
    canary: summary.canaryAllowed ? "allow" : "block",
    reason: summary.canaryReason,
    dataset: summary.exportedPath,
  };
}

export function runLearningNightly(configPath?: string): string {
  const result = runLearningNightlyResult(configPath);
  return [
    `events=${result.events}`,
    `passRate=${result.passRate.toFixed(3)}`,
    `avgTokens=${result.avgTokens.toFixed(1)}`,
    `canary=${result.canary}`,
    `reason=${result.reason}`,
    `dataset=${result.dataset}`,
  ].join("; ");
}

export interface PlanPreviewResult {
  mode: "simple" | "complex";
  ideas: string[];
  nodes: Array<{ id: string; description: string; dependencies: string[] }>;
}

export function planAndBrainstormResult(task: string): PlanPreviewResult {
  const mode = triageTask(task);
  const ideas = brainstormTask(task);
  const nodes = planTasks(task).map((node) => ({
    id: node.id,
    description: node.description,
    dependencies: node.dependencies,
  }));

  return {
    mode,
    ideas,
    nodes,
  };
}

export function planAndBrainstorm(task: string): string {
  const result = planAndBrainstormResult(task);
  return [
    `mode=${result.mode}`,
    `ideas=${result.ideas.join(" | ")}`,
    `plan=${result.nodes
      .map((node) => `${node.id}[${node.dependencies.join(",") || "-"}]:${node.description}`)
      .join(" | ")}`,
  ].join("; ");
}

function extractTokenCost(feedback: string): number {
  const match = feedback.match(/tokens=(\d+)/);
  if (match && match[1]) {
    return Number(match[1]);
  }

  return Math.max(1, Math.ceil(feedback.length / 4));
}

function loadGraphStore(config: GraphFlowConfig): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const transport = config.graphPolicy.transport;

  if (transport === "memory") {
    return { nodes: [], edges: [] };
  }

  if (transport === "sqlite") {
    const dbPath = config.graphPolicy.graphStorePath ?? "tmp/graphflow-graph.sqlite";
    try {
      const client = new GraphifySqliteClient(dbPath);
      const snapshot = client.readSnapshot();
      client.close();
      return snapshot;
    } catch {
      const fallbackPath =
        config.graphPolicy.graphStorePath?.replace(/\.sqlite$/i, ".json") ?? "tmp/graphflow-graph.json";
      return readFileGraphStore(fallbackPath);
    }
  }

  const storePath = config.graphPolicy.graphStorePath ?? "tmp/graphflow-graph.json";
  return readFileGraphStore(storePath);
}

async function resolveGraphStoreAfterIndex(
  config: GraphFlowConfig,
  graphClient: GraphClient
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (config.graphPolicy.transport === "memory" && graphClient.readSnapshot) {
    return graphClient.readSnapshot();
  }

  return loadGraphStore(config);
}

function readFileGraphStore(storePath: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!storePath || !existsSync(storePath)) {
    return { nodes: [], edges: [] };
  }

  try {
    const raw = readFileSync(storePath, "utf8");
    if (!raw.trim()) {
      return { nodes: [], edges: [] };
    }

    const parsed = JSON.parse(raw) as Partial<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
    return {
      nodes: parsed.nodes ?? [],
      edges: parsed.edges ?? [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function parseEnvPlaceholder(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  return match?.[1];
}

function readRawConfig(configPath: string): Partial<GraphFlowConfig> | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Partial<GraphFlowConfig>;
  } catch {
    return undefined;
  }
}

function estimateRawContextTokens(
  store: { nodes: GraphNode[]; edges: GraphEdge[] },
  query: string,
  compressedTokens: number
): number {
  const matching = store.nodes.filter((node) => {
    const haystack = `${node.id} ${node.type} ${node.content}`.toLowerCase();
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((item) => item.length >= 2);
    return terms.length === 0 || terms.some((term) => haystack.includes(term));
  });
  const nodes = matching.length > 0 ? matching : store.nodes;
  const rawTokens = nodes.reduce(
    (sum, node) => sum + estimateTokenCount(`${node.id}\n${node.type}\n${node.content}`),
    0
  );

  return Math.max(compressedTokens, rawTokens, estimateTokenCount(query));
}

function calculateSavingsPercent(rawTokens: number, compressedTokens: number): number {
  if (rawTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(((rawTokens - compressedTokens) / rawTokens) * 100)));
}

function calculateBudgetUsedPercent(compressedTokens: number, maxContextTokens: number): number {
  if (maxContextTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.round((compressedTokens / maxContextTokens) * 100));
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
}

function compactPreview(content: string, maxLength: number): string {
  const compacted = content.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function parseSkillInsight(node: GraphNode): SkillInsightItem | undefined {
  try {
    const parsed = JSON.parse(node.content) as Partial<SkillInsightItem>;
    if (!parsed.id || !parsed.name) {
      return undefined;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return undefined;
  }
}
