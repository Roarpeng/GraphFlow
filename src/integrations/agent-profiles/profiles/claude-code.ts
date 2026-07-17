import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerClaudeCodeProfile(): void {
  const { home } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "claude-code",
    name: "Claude Code",
    markerPaths: [
      join(home, ".claude"),
      join(home, ".claude.json"),
    ],
    userTargets: [
      { configPath: join(home, ".claude.json"), serversKey: "mcpServers" },
    ],
    workspaceRelativePaths: [{ relativePath: ".mcp.json", serversKey: "mcpServers" }],
  });
}

registerClaudeCodeProfile();
