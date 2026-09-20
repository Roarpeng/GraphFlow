import type { GraphEdge, GraphNode, TaskStatus } from "../../../core/types";
import type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode } from "../../../graph/snapshot-view.js";
import type { RuntimeTimelineSummary } from "../../../core/cancellation";
import type { AgentWorkItem } from "../../../core/agent-delegation";

export type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode };
import type { GraphFlowConfig } from "../../../config/schema";
import type { DialogueThreadEchoView } from "../../../learning/dialogue-thread";
import type { TeamDiagnosis } from "../../team/diagnose.js";

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
    /**
     * Estimated raw (uncompressed) context tokens. Keeps its floor semantics
     * after post-packaging accounting: never below the accounted payload
     * actually sent (see `accountedTokens`).
     */
    estimatedRawTokens: number;
    /**
     * Budgeted payload tokens: the layered package plus summary lines
     * prepended after packaging (dialogue recall / workbench / thread spine).
     * Always equals the top-level `tokenEstimate`.
     */
    compressedTokens: number;
    /**
     * Savings against the TRUE accounted payload (`accountedTokens` when
     * present), so post-packaging additions no longer inflate the ROI.
     */
    estimatedSavingsPercent: number;
    /**
     * Deterministic grep+read-fragment baseline — the honest comparison for
     * agents that already have grep+read, unlike `estimatedRawTokens` which
     * assumes reading every matching file. Formula (see
     * `estimateGrepBaselineTokens`): fs.stat bytes of the top L1 File anchor
     * / 4 * 0.25 fragment share + 200 fixed grep overhead, capped at
     * `estimatedRawTokens`; falls back to `estimatedRawTokens * 0.3` when the
     * anchor file cannot be statted. Best-effort: omitted when decoration
     * could not run.
     * grep+读片段基线的确定性估算（对已有 grep+read 的 agent 的诚实对照，
     * 区别于"读全部相关文件"的 estimatedRawTokens）：top L1 File anchor 的
     * 字节数 / 4 × 0.25 + 200 固定 grep 开销，封顶 estimatedRawTokens；
     * stat 失败回退 estimatedRawTokens × 0.3。尽力而为字段。
     */
    estimatedGrepBaselineTokens?: number;
    /**
     * Savings percent of the accounted payload against the grep baseline
     * (`estimatedGrepBaselineTokens`) — same clamped [0,100] semantics and
     * same denominator (`accountedTokens` when present) as
     * `estimatedSavingsPercent`.
     * accountedTokens 相对 grep 基线的节省百分比；与 estimatedSavingsPercent
     * 相同的 [0,100] 截断语义和分母口径。
     */
    estimatedSavingsPercentVsGrep?: number;
    /** `compressedTokens / maxContextTokens` — budgeted share; excludes `unbudgetedTokens`. */
    budgetUsedPercent: number;
  };
  /**
   * Token cost of additive payloads that ride OUTSIDE the layered L1-L3
   * package and are not governed by the layer quota (currently
   * `dialogueHits`, plus dialogue-thread prompt lines when they are not
   * injected into `summary`). Never folded into `tokenBudget.compressedTokens`;
   * present only when non-zero.
   * 分层配额之外附加下发负载的 token 成本（当前为 dialogueHits，以及未注入
   * summary 的 dialogueThread promptLines）；不折进 compressedTokens，仅非零时出现。
   */
  unbudgetedTokens?: number;
  /**
   * True accounted payload total = `tokenBudget.compressedTokens` +
   * `unbudgetedTokens`. Present only when post-packaging additions were
   * accounted; otherwise the true total is `tokenBudget.compressedTokens`.
   * 真实下发总量 = 预算内 + 预算外；仅发生打包后追加记账时出现。
   */
  accountedTokens?: number;
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
  /**
   * Connected conversation spine (user Q + LLM A) for staying on the main
   * thread. Echo view: turn ids / seq / jumped verbatim, Q/A text clipped to
   * previews (see `toDialogueThreadEchoView`).
   */
  dialogueThread?: DialogueThreadEchoView;
  /**
   * Historical dialogue turns recalled for this query (Conversation Graph
   * W2b). Additive-only: rides in its own field and never displaces code
   * anchors. Superseded turns are hidden unless the query history matters.
   * Echo view — ids and marks verbatim, `userQuery` clipped to a preview
   * with `truncated` set when cut; full text lives in the graph store.
   * 回显瘦身视图：userQuery 裁成预览并标记 truncated；全文留在图谱直读。
   * Under the hard response budget (see `response-budget.ts`) `userQuery` is
   * the first hit field to drop, so it is optional on the wire.
   */
  dialogueHits?: Array<
    Omit<import("../../../graph/graph-search.js").DialogueHitPreview, "userQuery"> & {
      userQuery?: string;
    }
  >;
  /**
   * Response-budget degradation steps that actually executed, in ladder
   * order ("outline" / "dialogueHits.userQuery" / "promptLines" /
   * "dialogueHits"). Present only when the serialized response exceeded
   * MAX_RESPONSE_BYTES and had to be slimmed (see `response-budget.ts`).
   * 响应超预算时实际执行过的降级步骤，按序列出；未超预算则不出现。
   */
  degraded?: string[];
  /**
   * Active workbench topic container (function node on the canvas). Echo view:
   * structure and ids verbatim, message text clipped to previews (see
   * `toWorkbenchEchoView`); full text lives in the graph store.
   */
  workbench?: import("../../../learning/workbench-topic").WorkbenchEchoView;
  /**
   * R9 cross-session reminder: unresolved obligations (dangling deps,
   * unwired files, unreferenced container/loader configs, doc drift) from
   * previous sessions, read from the promise ledger. Additive-only; present
   * only when open entries exist.
   */
  pendingFollowThroughs?: string;
  /** What this preview wrote into the dialogue/workbench graph. */
  dialogueCapture?: DialogueCapture;
  /**
   * SoL-Pi-style "Online Context Compact" advisory (opt-in via
   * `efficiencyPolicy.contextPressure.enabled`). Reports the effective budget
   * actually used for packaging and, when the caller supplies prefix tokens +
   * a remaining-turn estimate, an economic compaction recommendation. GraphFlow
   * cannot call the host's compaction API; this is a signal the host may act on.
   */
  contextPressure?: {
    enabled: true;
    /** "auto" scales the default by observed pressure; "fixed" pins a number. */
    budgetMode: "auto" | "fixed";
    /** Budget GraphFlow actually packed against for this preview. */
    effectiveMaxContextTokens: number;
    usedTokens?: number;
    maxTokens?: number;
    pressureRatio?: number;
    compaction?: import("../../../graph/context-pressure.js").CompactionSignal;
  };
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
  /**
   * SoL-Pi-style efficiency mechanisms. All default ON (best config); the
   * graphflow-settings page can switch each one off.
   */
  observationsEnabled?: boolean;
  observationReduceEnabled?: boolean;
  contextPressureEnabled?: boolean;
  actionFusionEnabled?: boolean;
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
  /**
   * Slim resume pointer kept when the full outline is omitted
   * (`inspectGraph` options `includeOutline` defaults to false): the most
   * recently updated outline of THIS workspace — enough for a
   * `graphflow_context({ topicId })` resume without the outline bulk. The
   * full tree stays available via `includeOutline: true` or CLI
   * `graphflow workbench tree`.
   * 省略全量 outline 时保留的续聊指针（本工作区最近活跃主题）。
   */
  workbenchResume?: {
    rootId: string;
    activeTopicId: string;
  };
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
  /** Worker's final textual answer (present on llm-mode completions). */
  result?: string;
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
  /** Team shared-memory / RBAC snapshot (mcp-http). Live probe fields are optional. */
  team?: TeamDiagnosis;
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
   * R9 closing audit attached to this success report: unresolved follow-through
   * findings (dangling deps / unwired files / unreferenced configs / doc drift)
   * recorded into the promise ledger. Strict mode (GRAPHFLOW_AUDIT_STRICT=1)
   * instead refuses the report via `ok:false`.
   */
  closingAudit?: {
    errors: number;
    warnings: number;
    reminder: string;
  };
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
  /**
   * When expanding a dialogue-turn node: the session spine so the agent can
   * resume. Echo view — turn ids verbatim, Q/A text clipped to previews.
   */
  dialogueThread?: DialogueThreadEchoView;
}

export interface LearningNightlyResult {
  totalEvents: number;
  passRate: number;
  averageTokenCost: number;
  exportedPath: string;
  lessonsSynthesized?: number;
}
