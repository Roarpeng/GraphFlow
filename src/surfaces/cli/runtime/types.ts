import type { GraphEdge, GraphNode, TaskStatus } from "../../../core/types";
import type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode } from "../../../graph/snapshot-view.js";
import type { RuntimeTimelineSummary } from "../../../core/cancellation";
import type { AgentWorkItem } from "../../../core/agent-delegation";

export type { GraphSnapshotSampleEdge, GraphSnapshotSampleNode };

/**
 * What is stable across turns, declared so the host can cache it.
 *
 * The split is not a guess about the host's prompt: it is a statement about
 * *this package's own content*. A repo map, module inventory and project
 * conventions change when the code changes, not when the agent asks something
 * new. The query-scoped anchors and the dialogue recall change on every single
 * call. Telling the host which is which is the whole value — it is what lets the
 * host put a cache breakpoint between them instead of after them.
 */
/**
 * The project brief: the cross-turn stable segment GraphFlow owns.
 *
 * Without it, `cacheLayout.stablePrefix` is 19 tokens of module label and the
 * host has nothing worth placing before its breakpoint. The brief is derived
 * from the repository rather than the question, and is reused until validation
 * says the code moved under it.
 */
export interface ProjectBriefView {
  lines: string[];
  tokens: number;
  /** True when a stored brief was reused instead of rebuilt. */
  reused: boolean;
  /** Why it was reused or rebuilt. Never empty — a silent rebuild is untrustworthy. */
  reason: string;
  /** Refs from the stored brief that no longer resolved, when it was checked. */
  deadRefs: string[];
}

export interface CacheLayout {
  /**
   * Cross-turn stable content: repo/module map, project conventions, the
   * long-lived working set. Cached content — place before the breakpoint.
   */
  stablePrefix: {
    lines: string[];
    tokens: number;
  };
  /**
   * Per-turn varying content: query-scoped anchors, dialogue recall, and
   * anything else derived from this specific request. Place after the
   * breakpoint; injecting it earlier invalidates everything downstream.
   */
  delta: {
    lines: string[];
    tokens: number;
  };
  /**
   * Where to put each half, named the way a host can act on it.
   *
   * Measured on DeepSeek (benchmarks/cache-placement-ab.ts, 40 turns of
   * history): putting the volatile half in the system layer drops the hit ratio
   * from 95.1% to 43.1% and re-bills the whole conversation every turn, because
   * the surviving cache is exactly the stable prefix. Putting a byte-stable
   * brief in the same position costs nothing (94.1%). So the position is the
   * whole game, and "stable first, delta second" is not enough on its own — a
   * host that concatenates both into the system block follows the order and
   * still loses the cache.
   */
  insertion: CacheInsertionAdvice;
  /**
   * Estimated share of the host's request prefix that would survive if the host
   * ordered by this declaration. Null when the host's own prefix is unknown
   * (GraphFlow is not the harness and cannot see it).
   */
  reusablePrefixShare: number | null;
  /**
   * Why the split looks like this, in one sentence, for the host to surface to
   * the agent if useful. Never empty.
   */
  note: string;
}

/**
 * Copy-pasteable placement advice.
 *
 * `system` and `turn-tail` are the two slots a host actually has. The advice is
 * deliberately concrete rather than advisory: a host that is told "put the
 * volatile part somewhere stable-ish" will put it in the system block, and that
 * is the exact arrangement the measurement rules out.
 */
export interface CacheInsertionAdvice {
  /** Put the stable segment in the host's cached system/static region. */
  stableAt: "system";
  /**
   * Put the delta at the end of the current turn — after the conversation, not
   * in the system block. This is the half that is easy to get wrong.
   */
  deltaAt: "turn-tail";
  /** A single instruction a host can implement without interpreting anything. */
  recipe: string;
  /** The measured basis, so a host can verify instead of trusting us. */
  evidence: string;
  /**
   * True when following this advice is even possible for the payload: a delta
   * that the host has no way to append late is worth flagging rather than
   * silently assuming.
   */
  actionable: boolean;
}
import type { GraphFlowConfig } from "../../../config/schema";
import type { DialogueThreadEchoView } from "../../../learning/dialogue-thread";
import type { ContextEconomics } from "../../../graph/context-economics";
import type { AbstainHandle, AbstentionFloor } from "../../../graph/abstention-floor";
import type { SkillFreshness } from "../../../learning/memory-freshness";
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
  /** Declaration bodies quoted into the pack, and why the others stayed pointers. */
  anchorBodies?: import("../../../graph/anchor-bodies").AnchorBodyStats;
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
  /**
   * Present only when GRAPHFLOW_CONTEXT_ECONOMICS=1. Reports the axis the
   * token-savings percent does not: how much of the injected prefix survived
   * from the previous turn, what that does to provider prompt-cache reuse, the
   * resulting input cost, and the attention budget against the context-rot
   * threshold. A large savings percent with verdict 'prefix-churn' is a warning
   * that the cheap tokens were paid for with a cold cache.
   */
  economics?: ContextEconomics;
  /**
   * Present only when GRAPHFLOW_ABSTAIN=1 or GRAPHFLOW_ABSTAIN_ENFORCE=1.
   * Progressive disclosure buys context, not intelligence: on a small corpus with
   * a concrete ref the agent can read the passage itself, so the package can be
   * redundant cost. Surfaced explicitly (never silently) so the host can skip
   * the read. `enforced` separates "we recommended it" from "we did it" — only
   * GRAPHFLOW_ABSTAIN_ENFORCE=1 ever drops anchors, and only when the capability
   * floor holds. `floor` carries the full A/B measurement (evidence recall, file
   * count, read amplification) so the default can be decided on numbers.
   */
  abstention?: {
    abstained: boolean;
    reason: string;
    enforced?: boolean;
    floor?: AbstentionFloor;
  };
  /**
   * Present only when abstention was enforced. The "go read this" pointers that
   * replaced the dropped anchors. Each is one file plus the earliest line an
   * anchor occupied in it.
   */
  handles?: AbstainHandle[];
  /**
   * Declares which parts of this package are cache-stable and which change every
   * turn, so the host can place them correctly in its own prompt. Advisory only:
   * GraphFlow is a plugin and does not decide breakpoints or ordering.
   *
   * 发布顺序规则是"前稳后动"——把每轮变化的内容放在稳定内容之前，会连带作废其
   * 后所有 token 的缓存（provider 的缓存是自左向右的前缀匹配，一个字节不同，
   * 其后每 token 都要按写入价重付）。实测见 `economics.invalidation`：
   * 50k tok 宿主历史下，一轮 churn 的重写税可达压缩收益的 10 倍。
   *
   * Declaration, not a decision. 本字段只做声明，不代宿主摆放。
   */
  cacheLayout?: CacheLayout;
  /**
   * Present only when GRAPHFLOW_PROJECT_BRIEF=1. The stable, reusable segment
   * of the package, plus whether it was reused or rebuilt and why. Report-only
   * until a host demonstrably consumes it.
   *
   * Present only when GRAPHFLOW_PROJECT_BRIEF=1。跨轮稳定的项目级摘要，
   * 附复用/重建状态与理由；宿主消费前只上报，不进入注入路径。
   */
  projectBrief?: ProjectBriefView;
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
  /** Semantic vectors this run wrote, and how far the store still is from covered. */
  vectorBackfill?: {
    missing: number;
    stale: number;
    refreshed: number;
    fingerprint?: string;
    budget?: { limit: number; deadlineMs: number };
  };
}

export interface GraphRebuildResult extends GraphIndexResult {
  cleared: boolean;
  storePath: string;
  /** Memory nodes (dialogue, workbench, skills, episodes, insights) carried across the rebuild. */
  preservedMemory?: { nodes: number; edges: number; droppedEdges: number };
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
  /**
   * Present only when GRAPHFLOW_FRESHNESS=1. The freshness oracle: whether the
   * symbols this skill was learned from still resolve in the code graph. A
   * `stale` proven skill is doing more harm than a missing one — it is wrong
   * with the confidence of past evidence.
   */
  freshness?: SkillFreshness;
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
  /**
   * Present when the LLM was configured but the pre-flight round-trip
   * failed, so execution fell back to bridge mode exactly as if no LLM
   * existed — the reason must stay visible (never a silent mode switch).
   */
  bridgeReason?: string;
  /** Worker's final textual answer (present on llm-mode completions). */
  result?: string;
  episodeId?: string;
  executionDescriptor?: {
    action: "execute";
    task: string;
    context: string;
    retryHints: string[];
  };
  /**
   * 2.x groundwork: deterministic Shadow advisory (Execution Contract embryo).
   * Pure Layer A output — zero LLM calls, workers may ignore it. Its own cost
   * is recorded in the decision ledger (graphflow-out/decision-ledger.jsonl).
   */
  advisory?: import("../../../core/efficiency-advisory").EfficiencyAdvisory;
}

export interface RoutingDiagnosisResult {
  dynamicRouting: boolean;
  health: Record<"openai" | "anthropic" | "bailian" | "doubao" | "deepseek", boolean>;
  /**
   * Real apikey+baseUrl+model round-trips for the active planner/worker
   * selections. `health` above is CONFIG-PRESENCE derived and can be true
   * while every actual call fails (e.g. revoked key); these probes are the
   * ground truth. Attached by the diagnose CLI surface only (bounded).
   */
  connectivityProbes?: RoutingConnectivityProbe[];
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
    /** Configured ONNX precision for the local model (q8 by default). */
    dtype?: string;
    incompatibleVectorsSkipped?: number;
    vectorBackfill?: {
      missing: number;
      stale: number;
      refreshed: number;
      fingerprint?: string;
      budget?: { limit: number; deadlineMs: number };
      at: number;
    };
  };
  /** Which store this process uses and whether all hosts can share it. */
  graphStore?: {
    transport: string;
    backend?: "sqlite" | "file" | "memory" | "mcp-http";
    path?: string;
    fallbackReason?: string;
    sqliteModuleSource?: "bundled" | "optional-deps";
    /** A JSON store sits next to the SQLite store and has not been merged yet. */
    unmergedJsonStore: boolean;
    lastMerge?: { mergedAt: string; stats: Record<string, number> };
    runtimeDeps: Array<{ name: string; source: string; version?: string; loadError?: string }>;
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
  /**
   * Where this plan actually came from (first-class, machine-readable — the
   * same story agentInstructions tells in prose):
   * - `llm`: pre-flight probe passed AND both brainstorm + decomposition
   *   returned real model output (nodesStatus=final).
   * - `probe-failed-bridge`: pre-flight connectivity probe failed → template
   *   suggestion + agent bridge, LLM plan never attempted.
   * - `llm-failed-bridge`: probe passed but brainstorm/decomposition failed
   *   or timed out → template suggestion + agent bridge.
   * - `no-llm-bridge`: no usable provider credentials at all.
   */
  planSource?: "llm" | "probe-failed-bridge" | "llm-failed-bridge" | "no-llm-bridge";
  /** Pre-flight planner round-trip performed for this plan (when one ran). */
  probe?: RoutingConnectivityProbe;
  /** Why a bridge/degrade happened; absent when planSource is `llm`. */
  degradeReason?: string;
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
  /**
   * Whether the snippet really is the indexed symbol. `exact` = the stored
   * signature sits in the window; `relocated` = the signature was found at a
   * different line and the window follows it; `drifted` = the signature is no
   * where in the file, so the snippet is the old position and must not be
   * edited blind. Never reported as verified when it is not.
   */
  verified?: "exact" | "relocated" | "drifted";
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
