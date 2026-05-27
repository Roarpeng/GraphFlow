export interface GraphFlowConfig {
  providers: Record<string, { apiKey?: string; baseUrl?: string }>;
  tiers: {
    smart: { provider: string; model: string };
    economy: { provider: string; model: string };
  };
  budgetPolicy: {
    runTokenCap: number;
  };
}
