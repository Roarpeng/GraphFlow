import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerAntigravityProfile(): void {
  const { home, appData, localAppData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "antigravity",
    name: "Antigravity",
    markerPaths: [
      join(home, ".gemini", "antigravity"),
      join(home, ".antigravity"),
      join(appData, "Antigravity"),
      join(localAppData, "Programs", "Antigravity"),
    ],
    userTargets: [
      {
        configPath: join(home, ".gemini", "antigravity", "mcp_config.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: join(home, ".gemini", "config", "mcp_config.json"),
        serversKey: "mcpServers",
      },
    ],
    workspaceRelativePaths: [
      { relativePath: join(".agents", "mcp_config.json"), serversKey: "mcpServers" },
    ],
  });
}

registerAntigravityProfile();
