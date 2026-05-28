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
    workspaceRoot?: string;
    includeExtensions?: string[];
    transport: "memory" | "mcp-http";
    mcpEndpoint?: string;
    mcpApiKey?: string;
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
  };
}
