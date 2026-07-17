import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerGeminiProfile(): void {
  const { home } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "gemini",
    name: "Gemini",
    markerPaths: [
      join(home, ".gemini"),
    ],
    userTargets: [
      {
        configPath: join(home, ".gemini", "settings.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: join(home, ".gemini", "config", "mcp_config.json"),
        serversKey: "mcpServers",
      },
    ],
    workspaceRelativePaths: [
      { relativePath: join(".gemini", "settings.json"), serversKey: "mcpServers" },
    ],
  });
}

registerGeminiProfile();
