export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /** DeepSeek thinking mode; auto = map by GraphFlow role. */
  thinking?: "enabled" | "disabled" | "auto";
  reasoningEffort?: "high" | "max";
  /** Force JSON object response_format when supported. */
  jsonMode?: boolean | "auto";
  /** Allow DeepSeek tool_calls against read-only graph tools. */
  enableTools?: boolean;
}

/**
 * SoL-Pi-style efficiency mechanisms (see docs: "efficiency for efficiency").
 *
 * The default is the best configuration (every mechanism ON). A user can
 * switch any mechanism off from the graphflow-settings page, or set an explicit
 * false here. These flags govern config-driven/automatic
 * behaviour only — an explicit API call (e.g. graphflow_context with
 * content/handle, or graphflow_run receiving an executionDescriptor) is
 * explicit intent and still operates when the flag is off.
 */
export interface ObservationReducerConfig {
  /** Enable reduction to a bounded receipt. Default false. */
  enabled?: boolean;
  /**
   * "fingerprint" (local, deterministic, default) or "llm" (delegate reading
   * to a cheap model). "llm" requires provider + model; without them the
   * resolver downgrades to "fingerprint".
   */
  strategy?: "fingerprint" | "llm";
  /** Token cap for the verified receipt. Default 400. */
  maxReceiptTokens?: number;
  /** Refuse to reduce a source larger than this (bytes). Default 2 MiB. */
  maxSourceBytes?: number;
  /** Remote reducer provider namespace. Required when strategy is "llm". */
  provider?: string;
  /** Remote reducer model id. Required when strategy is "llm". */
  model?: string;
}

export interface ObservationEfficiencyConfig {
  /** Archive oversized outputs behind a handle. Default false. */
  enabled?: boolean;
  /** Outputs at or below this size are returned inline (bytes). Default 8192. */
  inlineThresholdBytes?: number;
  /** Head excerpt budget of a packed observation (bytes). Default 2048. */
  headBytes?: number;
  /** Tail excerpt budget of a packed observation (bytes). Default 1536. */
  tailBytes?: number;
  /** Store cap; oldest entries evict first (bytes). Default 256 MiB. */
  maxStoreBytes?: number;
  /** Lazy TTL for archived blobs (days). Default 14. */
  ttlDays?: number;
  /** Redact secrets before writing to disk. Default true. */
  redactOnStore?: boolean;
  reduce?: ObservationReducerConfig;
}

export interface ContextPressureEfficiencyConfig {
  /** Enable observed-pressure budget + compaction signal. Default false. */
  enabled?: boolean;
  /**
   * "auto" (default when enabled) scales graphPolicy.maxContextTokens by the
   * observed window pressure supplied by the caller; a number pins the budget.
   */
  maxContextTokens?: number | "auto";
  /** Cache write/read cost ratio for the compaction economic check. Default 12.5. */
  cacheWriteReadRatio?: number;
  /** Minimum projected-saving ratio required to recommend compaction. Default 0.2. */
  minSavingRatio?: number;
}

export interface ActionFusionEfficiencyConfig {
  /** Attach fused edit+validate steps to executionDescriptors. Default false. */
  enabled?: boolean;
}

export interface EfficiencyPolicyConfig {
  observations?: ObservationEfficiencyConfig;
  contextPressure?: ContextPressureEfficiencyConfig;
  actionFusion?: ActionFusionEfficiencyConfig;
  /**
   * Efficiency-for-efficiency reinvestment (SoL-Pi closeout): converts
   * qualifying paired savings into an advisory mechanism-trial budget.
   */
  reinvest?: ReinvestEfficiencyPolicyConfig;
}

export interface ReinvestEfficiencyPolicyConfig {
  enabled?: boolean;
  /** Share of new qualifying savings convertible to search budget (0..1). Default 0.5. */
  ratio?: number;
  /** Per-round budget cap. Default 200000. */
  maxBudgetTokens?: number;
  /** Assumed cost of one mechanism trial. Default 4000. */
  estimatedTrialTokens?: number;
}

export interface GraphFlowConfig {
  providers: Record<string, ProviderConfig>;
  tiers: {
    smart: { provider: string; model?: string };
    economy: { provider: string; model?: string };
  };
  budgetPolicy: {
    runTokenCap: number;
  };
  graphPolicy: {
    enableAutoBuild: boolean;
    enableNearLosslessMode?: boolean;
    autoIndexOnPreview?: boolean;
    autoIndexOnRun?: boolean;
    autoIndexOnSave?: boolean;
    /**
     * Record each context preview as a dialogue-turn graph node (user question
     * + optional LLM reply) and inject the thread spine into later previews.
     * Default true. Set false to disable.
     */
    enableDialogueThread?: boolean;
    workspaceRoot?: string;
    includeExtensions?: string[];
    /**
     * Skip files git ignores when indexing (exact semantics via `git ls-files
     * --exclude-standard`). Default true; ignored outside git checkouts.
     */
    respectGitIgnore?: boolean;
    /**
     * Reference edges (file → definition) are skipped for names defined in more
     * than this many files — ubiquitous identifiers (`__init__`, `result`, …)
     * otherwise dominate the graph. Default 10; 0 disables the limit.
     */
    referenceEdgeMaxDefinitionFiles?: number;
    /** Max reference edges per source file. Default 500; 0 disables the cap. */
    referenceEdgeMaxPerFile?: number;
    /**
     * Worker threads used to parse files during indexing. `0` disables the pool
     * (in-process parsing), a positive number pins the count, absent = auto
     * (cores - 1, capped). `GRAPHFLOW_INDEX_WORKERS=0` disables it globally.
     */
    indexWorkers?: number;
    transport: "memory" | "mcp-http" | "file" | "sqlite" | "auto";
    /**
     * Graphify team-backend endpoint (transport: "mcp-http" only). Must be an
     * http(s) URL, e.g. "http://graphify.team.internal:8080". When the endpoint
     * is missing, malformed, or unreachable, GraphFlow logs a warning and falls
     * back to the local JSON file store (graphPolicy.graphStorePath).
     */
    mcpEndpoint?: string;
    /** Optional bearer token or JWT sent as `Authorization: Bearer <key>` to the team endpoint. */
    mcpApiKey?: string;
    /** Tenant id sent as `X-GraphFlow-Tenant` (mcp-http only). Defaults to `default`. */
    mcpTenant?: string;
    graphStorePath?: string;
    maxContextTokens: number;
    layerQuota?: {
      l1: number;
      l2: number;
      l3: number;
    };
    /**
     * Embedding backend for vector recall (R7-b: semantic-on by default).
     * "transformers" = resilient local: try the canonical local semantic model
     * first (Xenova/bge-base-zh-v1.5 via @huggingface/transformers), transparently
     * falling back to FNV-1a on any failure. "fnv" = explicit offline-safe
     * opt-out: deterministic FNV-1a bag-of-tokens embeddings, no downloads.
     */
    embeddingProvider?: "fnv" | "transformers";
    /**
     * Context compression model selection. Compression (cluster summarization,
     * node densification) reuses the economy tier by default ("inherit"), so
     * no extra config is needed: whatever provider powers economy also powers
     * compression. Falls back to an auto-downloaded embedded minicpm-1b when no
     * external provider is configured.
     */
    compression?: {
      enabled?: boolean;
      /** inherit=reuse economy tier (default), network=external API. */
      backend?: "inherit" | "network";
      /** Override provider (network backend only). */
      provider?: string;
      /** Override model; leave unset to inherit economy/default routing. */
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      timeoutMs?: number;
      /** Zero-cost graph-structure compression (edge weights + PageRank). Default true. */
      enableGraphCompression?: boolean;
      /** Return module-level RepoMap overview when budget is tight (<1000 tokens). Default false. */
      enableRepoMapFallback?: boolean;
      /** Adaptively size token budget from task complexity. Default true; complex tasks auto-enable even when unset. Set false to disable. */
      enableAdaptiveBudget?: boolean;
    };
  };
  learningPolicy: {
    enableFlywheel: boolean;
    trainingCadence: "nightly" | "weekly";
    exportPath: string;
    eventsPath?: string;
    summaryPath?: string;
  };
  routingPolicy?: {
    enableDynamicRouting?: boolean;
    requireApiKeyForHealthy?: boolean;
    providerPriority?: Array<"openai" | "anthropic" | "bailian" | "doubao" | "deepseek">;
    /** Allow provider tool_calls (DeepSeek) against read-only GraphFlow tools. */
    enableProviderTools?: boolean;
  };
  skillPolicy?: {
    enableSkillFlywheel?: boolean;
    maxSkillHints?: number;
  };
  embeddingPolicy?: {
    enabled?: boolean;
    provider?: "openai" | "transformers" | "hash";
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    /** Optional local cache for @xenova/transformers models; can be pre-seeded for offline use. */
    modelCacheDir?: string;
    /** Backward-compatible alias for modelCacheDir. */
    transformersCachePath?: string;
    vectorStorePath?: string;
    topK?: number;
    minSimilarity?: number;
    /** Opt in to vector recall across all graph nodes with embeddings. Default false. */
    enableFullGraphVectorRecall?: boolean;
  };
  /**
   * SoL-Pi-style efficiency mechanisms. Omitted sections leave their mechanism
   * disabled; see {@link EfficiencyPolicyConfig}.
   */
  efficiencyPolicy?: EfficiencyPolicyConfig;
}
