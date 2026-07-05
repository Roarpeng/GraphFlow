import type { GraphEdge, GraphNode, TaskStatus } from "../../../core/types";
import type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode } from "../../../graph/snapshot-view.js";

export type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode };
import type { GraphFlowConfig } from "../../../config/schema";

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
  /** Agent-translated English query used for symbol search (if provided). */
  englishQuery?: string;
  /** When CJK query yields few anchors, prompts the connected agent to translate to English. */
  agentMode?: "delegated-llm";
  agentWorkItems?: Array<{
    id: string;
    kind: string;
    prompt: string;
    expectedFormat: string;
    responseSchema?: Record<string, unknown>;
  }>;
  agentInstructions?: string;
}

export interface GraphFlowSettings {
  configPath: string;
  smartProvider: string;
  smartApiKey?: string;
  smartModel: string;
  smartBaseUrl?: string;
  economyProvider: string;
  economyApiKey?: string;
  economyModel: string;
  economyBaseUrl?: string;
  /** @deprecated use smartProvider */
  provider: string;
  /** @deprecated use smartApiKey / economyApiKey */
  apiKeyEnvVar?: string;
  /** @deprecated use smartBaseUrl / economyBaseUrl */
  baseUrl?: string;
  maxContextTokens: number;
  layerQuota: { l1: number; l2: number; l3: number };
  enableNearLosslessMode: boolean;
  autoIndexOnPreview: boolean;
  autoIndexOnRun: boolean;
  autoIndexOnSave: boolean;
  autoRunOnIndex: boolean;
  enableHnsw: boolean;
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  graphStorePath: string;
  enrichmentBackend: "network" | "local" | "inherit";
  enrichmentProvider: string;
  enrichmentModel: string;
  enrichmentApiKey?: string;
  enrichmentBaseUrl?: string;
}

export type GraphFlowSettingsInput = Omit<GraphFlowSettings, "configPath">;

export interface GraphIndexResult {
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
}

export interface GraphRebuildResult extends GraphIndexResult {
  cleared: boolean;
  storePath: string;
}

export interface GraphSnapshotResult {
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  storePath?: string;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCount: Record<GraphNode["type"], number>;
  topRelations: Array<{ relation: GraphEdge["relation"]; count: number }>;
  sampleNodes: GraphSnapshotSampleNode[];
  sampleEdges: GraphSnapshotSampleEdge[];
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
  episodeId?: string;
  executionDescriptor?: {
    action: "execute";
    task: string;
    context: string;
    retryHints: string[];
  };
}

export interface RoutingDiagnosisResult {
  dynamicRouting: boolean;
  health: Record<"openai" | "anthropic" | "bailian" | "doubao", boolean>;
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
  compression: {
    backend: string;
    provider: string;
    model: string;
    embedded: boolean;
  };
}

export interface SettingsValidationIssue {
  field: string;
  message: string;
}

export interface RoutingConnectivityProbe {
  role: "planner" | "worker";
  provider: string;
  model: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  sample?: string;
}

export interface RoutingConnectivityResult {
  ok: boolean;
  validationIssues: SettingsValidationIssue[];
  diagnosis: RoutingDiagnosisResult;
  probes: RoutingConnectivityProbe[];
  graphIndex?: { indexedFiles: number; indexedSymbols: number };
  graphSnapshot?: { nodeCount: number; edgeCount: number };
}

export interface GraphIndexFromSettingsResult {
  ok: boolean;
  validationIssues: SettingsValidationIssue[];
  graphIndex?: { indexedFiles: number; indexedSymbols: number };
  graphSnapshot?: { nodeCount: number; edgeCount: number };
}

export interface SettingsPanelStatusData {
  graphNodeCount: number;
  graphEdgeCount: number;
  graphLastModified: string | null;
  diagnoseSummary: string;
  overlayKeys: string[];
  baseConfigPath: string;
  mcpAgents: Array<{
    agentId: string;
    agentName: string;
    configPath: string;
    scope: "user" | "workspace";
    detected: boolean;
    installed: boolean;
  }>;
}

export interface PlanPreviewResult {
  mode: "simple" | "complex";
  ideas: string[];
  nodes: Array<{ id: string; description: string; dependencies: string[] }>;
}

export interface ReportOutcomeResult {
  ok: boolean;
  episodeId?: string;
  outcome?: "pass" | "fail";
  reason?: string;
}

export interface ExpandAnchorResult {
  anchorId: string;
  type: GraphNode["type"];
  content: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceSnippet?: string;
  metadata?: Record<string, unknown>;
}

export interface LearningNightlyResult {
  totalEvents: number;
  passRate: number;
  averageTokenCost: number;
  canaryAllowed: boolean;
  canaryReason: string;
  exportedPath: string;
  lessonsSynthesized?: number;
}
