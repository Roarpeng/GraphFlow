import { existsSync, readFileSync } from "node:fs";
import { brainstormTask } from "../../agents/brainstormer";
import { planTasks } from "../../agents/planner";
import { loadConfig, validateConfig } from "../../config/loader";
import { triageTask } from "../../core/triage";
import type { GraphEdge, GraphNode } from "../../core/types";
import type { GraphFlowConfig } from "../../config/schema";
import { orchestrate, type OrchestrateOptions } from "../../core/orchestrator";
import { createGraphClient } from "../../graph/client-factory";
import { indexWorkspaceFiles } from "../../graph/file-indexer";
import {
  buildLayeredContextPackage,
  createContextRefillManager,
} from "../../graph/context-slicer";
import { appendFeedbackEvent, runNightlyLearning } from "../../learning/nightly-trainer";
import { resolveModelForRole, resolveModelWithFallback } from "../../routing/model-router";
import { buildFallbackChain, buildProviderHealthMap } from "../../routing/provider-health";

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
      providerPriority: ["openai", "anthropic", "bailian", "doubao"],
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

export function inspectGraph(
  configPath?: string,
  options?: { nodeLimit?: number; edgeLimit?: number }
): GraphSnapshotResult {
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

  const store = loadFileGraphStore(config);
  if (!store) {
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

export function getSkillInsights(configPath?: string, limit = 12): SkillInsightsResult {
  const config = resolveConfig(configPath);
  const boundedLimit = Math.max(1, limit);
  const store = loadFileGraphStore(config);

  if (!store) {
    return {
      source: "unavailable",
      transport: config.graphPolicy.transport,
      ...(config.graphPolicy.graphStorePath ? { storePath: config.graphPolicy.graphStorePath } : {}),
      skills: [],
    };
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

export async function runTask(task: string, configPath?: string): Promise<string> {
  const config = resolveConfig(configPath);
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

  appendFeedbackEvent(config.learningPolicy.eventsPath ?? "tmp/learning-events.jsonl", {
    query: task,
    passed: result.status === "COMPLETED",
    tokenCost: extractTokenCost(result.feedback),
    retries: Math.max(0, result.attempts - 1),
  });

  return `status=${result.status}; attempts=${result.attempts}; feedback=${result.feedback}`;
}

export function diagnoseRouting(configPath?: string): string {
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

  return [
    `dynamicRouting=${config.routingPolicy?.enableDynamicRouting ? "on" : "off"}`,
    `health=openai:${health.openai},anthropic:${health.anthropic},bailian:${health.bailian},doubao:${health.doubao}`,
    `priority=${chain.join(",")}`,
    `planner=${planner.provider}/${planner.model}${planner.fallbackApplied ? ":fallback" : ""}`,
    `worker=${worker.provider}/${worker.model}${worker.fallbackApplied ? ":fallback" : ""}`,
    `validator=${validator.provider}/${validator.model}${validator.fallbackApplied ? ":fallback" : ""}`,
  ].join("; ");
}

export function runLearningNightly(configPath?: string): string {
  const config = resolveConfig(configPath);
  const summary = runNightlyLearning(config);
  return [
    `events=${summary.totalEvents}`,
    `passRate=${summary.passRate.toFixed(3)}`,
    `avgTokens=${summary.averageTokenCost.toFixed(1)}`,
    `canary=${summary.canaryAllowed ? "allow" : "block"}`,
    `reason=${summary.canaryReason}`,
    `dataset=${summary.exportedPath}`,
  ].join("; ");
}

export interface PlanPreviewResult {
  mode: "simple" | "complex";
  ideas: string[];
  nodes: Array<{ id: string; description: string; dependencies: string[] }>;
}

export function planAndBrainstorm(task: string): string {
  const mode = triageTask(task);
  const ideas = brainstormTask(task);
  const nodes = planTasks(task).map((node) => ({
    id: node.id,
    description: node.description,
    dependencies: node.dependencies,
  }));

  return [
    `mode=${mode}`,
    `ideas=${ideas.join(" | ")}`,
    `plan=${nodes
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

function loadFileGraphStore(config: GraphFlowConfig):
  | {
      nodes: GraphNode[];
      edges: GraphEdge[];
    }
  | undefined {
  if (config.graphPolicy.transport !== "file") {
    return undefined;
  }

  const storePath = config.graphPolicy.graphStorePath;
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
