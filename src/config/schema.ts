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
    smart: { provider: string; model: string };
    economy: { provider: string; model: string };
  };
  budgetPolicy: {
    runTokenCap: number;
  };
  graphPolicy: {
    enableAutoBuild: boolean;
    enableNearLosslessMode?: boolean;
    autoIndexOnPreview?: boolean;
    autoIndexOnRun?: boolean;
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
      model?: string;
      batchSize?: number;
      sleepMs?: number;
      timeoutMs?: number;
      autoRunOnIndex?: boolean;
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
}
