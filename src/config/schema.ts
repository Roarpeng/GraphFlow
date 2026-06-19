export type OpenBmbMode = "embedded" | "ollama" | "openai-compat";

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  mode?: OpenBmbMode;
  engine?: "command" | "node-llama-cpp";
  modelPath?: string;
  commandPath?: string;
  modelUrl?: string;
  modelSha256?: string;
  autoDownloadModel?: boolean;
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
    semanticEnrichment?: {
      enabled?: boolean;
      mode?: "streaming" | "post-index" | "off";
      /** network=cloud API, local=OpenBMB, inherit=economy tier (default). */
      backend?: "network" | "local" | "inherit";
      /** When set, overrides economy tier provider for graph semantic enrichment. */
      provider?: string;
      /** When set, overrides economy tier model; leave unset to inherit economy/default routing. */
      model?: string;
      /** Optional enrichment-only API key / base URL (network backend). */
      apiKey?: string;
      baseUrl?: string;
      batchSize?: number;
      sleepMs?: number;
      timeoutMs?: number;
      autoRunOnIndex?: boolean;
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
      /** inherit=reuse economy tier (default), network=external API, local=embedded minicpm. */
      backend?: "inherit" | "network" | "local";
      /** Override provider (network backend only). */
      provider?: string;
      /** Override model; leave unset to inherit economy/default routing. */
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      /** Auto-download embedded model on first use when falling back to local. Default true. */
      autoDownloadEmbedded?: boolean;
      /** Override embedded model path; defaults to ~/.graphflow/models/minicpm-1b.gguf. */
      embeddedModelPath?: string;
      timeoutMs?: number;
      /** Zero-cost graph-structure compression (edge weights + PageRank). Default true. */
      enableGraphCompression?: boolean;
      /** Return module-level RepoMap overview when budget is tight (<1000 tokens). Default false. */
      enableRepoMapFallback?: boolean;
      /** Adaptively size the token budget from task complexity. Default false. */
      enableAdaptiveBudget?: boolean;
      /** Use HNSW ANN index for large candidate sets (>=200 nodes). Default true. */
      enableHnsw?: boolean;
    };
  };
  learningPolicy: {
    enableFlywheel: boolean;
    trainingCadence: "nightly" | "weekly";
    canaryRatio: number;
    exportPath: string;
    eventsPath?: string;
    summaryPath?: string;
    skillEvolution?: {
      enabled?: boolean;
      model?: string;
      minCoOccur?: number;
      minSuccess?: number;
      enableTripleFusion?: boolean;
    };
  };
  routingPolicy?: {
    enableDynamicRouting?: boolean;
    requireApiKeyForHealthy?: boolean;
    providerPriority?: Array<"openai" | "anthropic" | "bailian" | "doubao" | "openbmb">;
  };
  skillPolicy?: {
    enableSkillFlywheel?: boolean;
    maxSkillHints?: number;
  };
  embeddingPolicy?: {
    enabled?: boolean;
    provider?: "local" | "openai" | "hash";
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    vectorStorePath?: string;
    topK?: number;
    minSimilarity?: number;
  };
}
