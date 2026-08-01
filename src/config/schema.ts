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
    workspaceRoot?: string;
    includeExtensions?: string[];
    transport: "memory" | "mcp-http" | "file" | "sqlite" | "auto";
    mcpEndpoint?: string;
    mcpApiKey?: string;
    graphStorePath?: string;
    maxContextTokens: number;
    layerQuota?: {
      l1: number;
      l2: number;
      l3: number;
    };
    /**
     * Embedding backend for vector recall (P0-1). Default "fnv" is
     * zero-config and offline-safe: deterministic FNV-1a bag-of-tokens
     * embeddings, no downloads. Set "transformers" to lazily load
     * all-MiniLM-L6-v2 via @huggingface/transformers (downloaded once, then
     * cached) for semantic query + node embeddings; any failure (missing
     * model cache, timeout, load error) transparently falls back to FNV-1a.
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
}
