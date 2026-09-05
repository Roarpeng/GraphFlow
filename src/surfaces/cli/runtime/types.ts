import type { GraphEdge, GraphNode, TaskStatus } from "../../../core/types";
import type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode } from "../../../graph/snapshot-view.js";
import type { RuntimeTimelineSummary } from "../../../core/cancellation";
import type { AgentWorkItem } from "../../../core/agent-delegation";

export type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode };
import type { GraphFlowConfig } from "../../../config/schema";
import type { DialogueThreadView } from "../../../learning/dialogue-thread";

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
  /** Connected conversation spine (user Q + LLM A) for staying on the main thread. */
  dialogueThread?: DialogueThreadView;
  /**
   * Historical dialogue turns recalled for this query (Conversation Graph
   * W2b). Additive-only: rides in its own field and never displaces code
   * anchors. Superseded turns are hidden unless the query history matters.
   */
  dialogueHits?: import("../../../graph/graph-search.js").DialogueSearchHit[];
  /** Active workbench topic container (function node on the canvas). */
  workbench?: import("../../../learning/workbench-topic").WorkbenchContextView;
  /** What this preview wrote into the dialogue/workbench graph. */
  dialogueCapture?: DialogueCapture;
}

export interface DialogueCapture {
  kind: "workbench" | "turn";
  id: string;
  /** True when the user question is stored but the assistant answer is still missing. */
  pendingReply: boolean;
  forked?: boolean;
  filled?: boolean;
}

export interface CaptureAssistantReplyResult {
  ok: boolean;
  filled: boolean;
  capture?: DialogueCapture;
  reason?: string;
}

export interface PreviewDialogueOptions {
  /** Click this workbench topic to refine / return to the mainline. */
  topicId?: string;
  /** Logical session name (hashed with workspace root). Default "main". */
  sessionId?: string;
  /** Continue from a previously recorded dialogue turn (click-to-resume). */
  resumeFromTurnId?: string;
  /** Original assistant answer to store on the pending turn/topic. Not an extracted abstract. */
  assistantReply?: string;
  /** Set false to skip recording this preview as a dialogue turn. */
  recordDialogue?: boolean;
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
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  graphStorePath: string;
  /** Index Markdown files (`.md`). */
  indexMarkdown?: boolean;
  /** Index Office/PDF after anydoc conversion. */
  indexOfficeDocs?: boolean;
  /** Vector backend: `fnv` (offline) or `transformers` (local semantic). */
  embeddingProvider?: "fnv" | "transformers";
  /** Extension-only: download @firecrawl/anydoc on activate. */
  downloadAnydoc?: boolean;
}

export type GraphFlowSettingsInput = Omit<GraphFlowSettings, "configPath">;

export interface GraphIndexResult {
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
  cancelled?: boolean;
  agentWorkItems?: AgentWorkItem[];
  agentInstructions?: string;
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
  workbenchOutline?: import("../../../learning/workbench-topic").WorkbenchOutline[];
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
  health: Record<"openai" | "anthropic" | "bailian" | "doubao" | "deepseek", boolean>;
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
  /** Active embedding backend (P0-1): "semantic" (MiniLM/OpenAI vectors) or "off" (FNV-1a hash / none). */
  embeddingBackend: "semantic" | "off";
  /** Lightweight embedding provider health / quality snapshot (in-process). */
  embeddingQuality?: {
    provider?: string;
    model?: string;
    dimensions?: number;
    totalCalls: number;
    failures: number;
    failureRate: number;
    lastError?: string;
    lastCallAt?: number;
    lastSample?: {
      relatedSimilarity: number;
      unrelatedSimilarity: number;
      separationScore: number;
      dimensions: number;
      sampledAt: number;
    };
    backend?: string;
    fallbackReason?: string;
  };
  runtimeTimeline: RuntimeTimelineSummary;
  workspaceRoot: {
    path: string;
    discovery: "env" | "config" | "auto" | "cwd";
    exists: boolean;
    hasPackageJson: boolean;
    stale: boolean;
  };
  graphFreshness: {
    hasIndexCache: boolean;
    stale: boolean;
    cacheFileCount: number;
  };
  modelCache: {
    exists: boolean;
    path: string;
    resolution: "env" | "default";
  };
  connectivitySummary: {
    total: number;
    healthy: number;
    unhealthy: number;
    providerNames: string[];
  };
  /** P0 flywheel observability — same source as `skill report` / graphflow_diagnose. */
  flywheel?: {
    autoCaptureEnabled: boolean;
    episodes: { total: number; pass: number; fail: number; pending: number };
    /**
     * Token savings vs outcome-unknown rates. `estimatedSavingsPercent` is
     * packaging ROI — not retrieval Hit@k or body coverage.
     */
    fidelity?: ContextFidelityMetrics;
    skills: {
      total: number;
      byOutcomeKind: {
        proven: number;
        correctable: number;
        "anti-pattern": number;
        noise: number;
      };
    };
    sessionJournal: { path: string; exists: boolean; pendingCount: number };
    /** P0 Experience-layer rates + consolidation tip (additive). */
    experience?: {
      episodeToSkillConversionRate: number;
      lessonsCoverageRate: number;
      antiPatternCount: number;
      provenSkillCount: number;
      consolidationHint: string;
      consolidation?: {
        updates: number;
        deletes: number;
        adds: number;
        actionable: number;
      };
    };
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
  /** Triage label when local-only; `agent-delegated` when no GraphFlow LLM (bridge). */
  mode: "simple" | "complex" | "agent-delegated";
  /** Original triage classification (kept when mode is agent-delegated). */
  triageMode?: "simple" | "complex";
  ideas: string[];
  nodes: Array<{
    id: string;
    description: string;
    dependencies: string[];
    skillRefs?: string[];
    avoidPatterns?: string[];
  }>;
  /** Same as nodes when bridge suggests a local heuristic DAG. */
  suggestedNodes?: Array<{
    id: string;
    description: string;
    dependencies: string[];
    skillRefs?: string[];
    avoidPatterns?: string[];
  }>;
  nodesStatus?: "suggested" | "final";
  agentWorkItems?: AgentWorkItem[];
  agentInstructions?: string;
  status?: "awaiting-agent" | "complete";
  complete?: boolean;
  requiresAgentBridge?: boolean;
  /** Topic-container canvas seeded from this plan (click a topicId to refine). */
  workbench?: {
    rootId: string;
    activeTopicId: string;
    topics: Array<{ id: string; title: string; mainline: boolean; isolated: boolean }>;
    outline?: import("../../../learning/workbench-topic").WorkbenchOutline;
  };
}

export interface ReportOutcomeResult {
  ok: boolean;
  episodeId?: string;
  outcome?: "pass" | "fail";
  reason?: string;
  /** Number of skill atoms upserted when the flywheel ran; 0 if skipped or no atoms. */
  skillsUpdated?: number;
  /** P1 — drift classification echoed back when reported (none / misread-requirement / scope-creep / tech-drift). */
  deviation?: string;
  /** Verification level derived from the supplied evidence package. */
  evidence?: import("../../../learning/evidence").EvidenceVerification;
  /**
   * Optional Engineering KG links written when callers pass requirementIds /
   * conceptIds / codeHints (episode → derived_from → eng nodes).
   */
  engineeringLinks?: {
    edgeCount: number;
    linkedRequirementIds: string[];
    linkedConceptIds: string[];
    linkedCodeNodeIds: string[];
  };
}

/**
 * Split metrics: token packaging savings is not information fidelity.
 * Retrieval Hit@k and body coverage are separate; expand File for full source.
 */
export interface ContextFidelityMetrics {
  estimatedSavingsPercent: number;
  pendingRatio: number;
  unknownOutcomeRatio: number;
  /** Number of persisted context-fidelity evaluation samples. */
  sampleCount: number;
  /** Mean expected-anchor hit rate across samples (1.0 = every expected anchor returned). */
  averageAnchorRecallPercent: number;
  /** Mean normalized source-to-package similarity across measurable samples; 0 if none. */
  averageBodyCoveragePercent: number;
  note: string;
}

export interface ExpandAnchorResult {
  anchorId: string;
  type: GraphNode["type"];
  content: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceSnippet?: string;
  metadata?: Record<string, unknown>;
  /** When expanding a dialogue-turn node: the session spine so the agent can resume. */
  dialogueThread?: DialogueThreadView;
}

export interface LearningNightlyResult {
  totalEvents: number;
  passRate: number;
  averageTokenCost: number;
  exportedPath: string;
  lessonsSynthesized?: number;
}
