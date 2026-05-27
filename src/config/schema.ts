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
    transport: "memory" | "mcp-http";
    mcpEndpoint?: string;
    mcpApiKey?: string;
    maxContextTokens: number;
  };
  learningPolicy: {
    enableFlywheel: boolean;
    trainingCadence: "nightly" | "weekly";
    canaryRatio: number;
    exportPath: string;
  };
}
