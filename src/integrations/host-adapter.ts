/**
 * Host capability registry (v1.13).
 *
 * Install dispatch lives in `host-adapter-install.ts`. Two kinds of hosts:
 * - **Hand-written slices** (host-specific behaviour: hooks, home overlays,
 *   placeholder rules): `deepseek-harness`, `cursor`, `claude-code`, `kimi-code`.
 * - **Profile-backed generic slices** (`profile-host-installer.ts`): every other
 *   registry host — MCP / Skill / instruction targets are already declarative.
 */
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
    capabilities: ["mcp-stdio", "skills", "rules", "hooks"],
    homeMarker: ".cursor",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    capabilities: ["mcp-stdio", "skills", "rules", "hooks"],
    homeMarker: ".claude",
  },
  {
    id: "kimi-code",
    displayName: "Kimi Code",
    capabilities: ["mcp-stdio", "skills", "rules"],
    homeMarker: ".kimi-code",
    toolPrefix: "mcp__graphflow__",
  },
  // ── Profile-backed hosts (generic slice) ──────────────────────────────
  { id: "trae", displayName: "Trae", capabilities: ["mcp-stdio"], homeMarker: ".trae" },
  { id: "vscode", displayName: "VS Code", capabilities: ["mcp-stdio"], homeMarker: ".vscode" },
  {
    id: "windsurf",
    displayName: "Windsurf",
    capabilities: ["mcp-stdio", "rules"],
    homeMarker: ".codeium",
  },
  {
    id: "cline",
    displayName: "Cline",
    capabilities: ["mcp-stdio", "rules"],
    homeMarker: ".cline",
  },
  {
    id: "roo-code",
    displayName: "Roo Code",
    capabilities: ["mcp-stdio", "skills", "rules"],
    homeMarker: ".roo",
  },
  {
    id: "kilocode",
    displayName: "Kilo Code",
    capabilities: ["mcp-stdio", "skills", "rules"],
    homeMarker: ".kilocode",
  },
  { id: "pearai", displayName: "PearAI", capabilities: ["mcp-stdio"] },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    capabilities: ["mcp-stdio", "rules", "hooks"],
    homeMarker: ".gemini",
  },
  {
    id: "codex",
    displayName: "Codex",
    capabilities: ["mcp-stdio", "skills", "rules", "hooks"],
    homeMarker: ".codex",
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    capabilities: ["mcp-stdio", "skills"],
    homeMarker: ".gemini/antigravity",
  },
  { id: "amazon-q", displayName: "Amazon Q", capabilities: ["mcp-stdio"] },
  { id: "zed", displayName: "Zed", capabilities: ["mcp-stdio"] },
  { id: "continue", displayName: "Continue", capabilities: ["mcp-stdio"] },
  {
    id: "qoder",
    displayName: "Qoder",
    capabilities: ["mcp-stdio", "skills"],
    homeMarker: ".qoder",
  },
  {
    id: "opencode",
    displayName: "Opencode",
    capabilities: ["mcp-stdio", "rules", "hooks"],
    homeMarker: ".config/opencode",
  },
] as const;

export function getHostAdapter(id: string): HostAdapter | undefined {
  return HOST_ADAPTERS.find((adapter) => adapter.id === id);
}

export function hostsWithCapability(capability: HostCapability): HostAdapter[] {
  return HOST_ADAPTERS.filter((adapter) => adapter.capabilities.includes(capability));
}
