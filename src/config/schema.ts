export interface GraphFlowConfig {
  providers: Record<string, { apiKey?: string; baseUrl?: string }>;
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
    transport: "memory" | "mcp-http" | "file";
    mcpEndpoint?: string;
    mcpApiKey?: string;
    graphStorePath?: string;
    maxContextTokens: number;
    layerQuota?: {
      l1: number;
      l2: number;
      l3: number;
    };
  };
  learningPolicy: {
    enableFlywheel: boolean;
    trainingCadence: "nightly" | "weekly";
    canaryRatio: number;
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
}
