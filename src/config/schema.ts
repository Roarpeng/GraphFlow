export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
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
    enableHnsw?: boolean;
    transport: "memory" | "mcp-http" | "file" | "sqlite";
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
    providerPriority?: Array<"openai" | "anthropic" | "bailian" | "doubao">;
  };
  skillPolicy?: {
    enableSkillFlywheel?: boolean;
    maxSkillHints?: number;
  };
  embeddingPolicy?: {
    enabled?: boolean;
    provider?: "openai" | "hash";
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    vectorStorePath?: string;
    topK?: number;
    minSimilarity?: number;
  };
}
