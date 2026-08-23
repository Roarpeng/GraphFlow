export type HostCapability =
  | "mcp-stdio"
  | "mcp-http"
  | "skills"
  | "rules"
  | "hooks"
  | "client-panel"
  | "workbench";

export interface HostAdapter {
  id: string;
  displayName: string;
  capabilities: readonly HostCapability[];
  /** Canonical home marker used by installers; empty for portable hosts. */
  homeMarker?: string;
  /** Tool prefix shown to the model, when the host namespaces MCP tools. */
  toolPrefix?: string;
}

export const HOST_ADAPTERS: readonly HostAdapter[] = [
  {
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    capabilities: ["mcp-stdio", "skills", "hooks", "client-panel", "workbench"],
    toolPrefix: "mcp__graphflow__",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    capabilities: ["mcp-stdio", "skills", "rules"],
    homeMarker: ".cursor",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    capabilities: ["mcp-stdio", "skills", "rules", "hooks"],
    homeMarker: ".claude",
  },
] as const;

export function getHostAdapter(id: string): HostAdapter | undefined {
  return HOST_ADAPTERS.find((adapter) => adapter.id === id);
}

export function hostsWithCapability(capability: HostCapability): HostAdapter[] {
  return HOST_ADAPTERS.filter((adapter) => adapter.capabilities.includes(capability));
}
