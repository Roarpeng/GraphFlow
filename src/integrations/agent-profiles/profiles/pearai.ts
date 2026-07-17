import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerPearAIProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "pearai",
    name: "PearAI",
    markerPaths: [
      join(home, ".pearai"),
      join(appData, "PearAI"),
    ],
    userTargets: [
      { configPath: join(home, ".pearai", "mcp.json"), serversKey: "mcpServers" },
      { configPath: join(appData, "PearAI", "User", "mcp.json"), serversKey: "mcpServers" },
    ],
    workspaceRelativePaths: [{ relativePath: join(".pearai", "mcp.json"), serversKey: "mcpServers" }],
  });
}

registerPearAIProfile();
