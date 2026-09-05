import type { GraphFlowConfig } from "../../config/schema.js";
import { resolveConfig } from "../../config/resolve.js";
import { createGraphClient } from "../../graph/client-factory.js";
import { GraphifyMcpClient, TeamAuthError } from "../../graph/graphify-mcp-client.js";

export interface TeamDiagnosis {
  enabled: boolean;
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  endpoint?: string;
  tenant?: string;
  authMode: "none" | "bearer" | "unknown";
  rbacExpected: boolean;
  reachable?: boolean;
  degradedToLocal?: boolean;
  role?: string;
  nodeCount?: number;
  skillPackRevision?: number | null;
  error?: string;
}

export function diagnoseTeamConfig(config: GraphFlowConfig): TeamDiagnosis {
  const { transport, mcpEndpoint, mcpApiKey, mcpTenant } = config.graphPolicy;
  const enabled = transport === "mcp-http";
  return {
    enabled,
    transport,
    ...(mcpEndpoint ? { endpoint: mcpEndpoint } : {}),
    tenant: mcpTenant?.trim() || "default",
    authMode: mcpApiKey?.trim() ? "bearer" : "none",
    rbacExpected: Boolean(mcpApiKey?.trim()),
  };
}

export async function probeTeamDiagnosis(configPath?: string): Promise<TeamDiagnosis> {
  const config = resolveConfig(configPath);
  const base = diagnoseTeamConfig(config);
  if (!base.enabled || !base.endpoint) {
    return base;
  }
  try {
    const client = createGraphClient(config);
    if (!(client instanceof GraphifyMcpClient)) {
      return { ...base, reachable: false, degradedToLocal: true, error: "mcp-http client unavailable" };
    }
    const reachable = await client.ping();
    const health = client.lastTeamHealth;
    return {
      ...base,
      reachable,
      degradedToLocal: !reachable || client.isDegraded,
      ...(health?.role ? { role: health.role } : {}),
      ...(typeof health?.nodeCount === "number" ? { nodeCount: health.nodeCount } : {}),
      ...(health && "skillPackRevision" in health ? { skillPackRevision: health.skillPackRevision ?? null } : {}),
      ...(reachable ? {} : { error: "team endpoint unreachable or unauthorized" }),
    };
  } catch (error) {
    const message = error instanceof TeamAuthError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    return {
      ...base,
      reachable: false,
      degradedToLocal: true,
      error: message,
    };
  }
}
