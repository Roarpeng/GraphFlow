import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerWindsurfProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "windsurf",
    name: "Windsurf",
    markerPaths: [join(home, ".codeium", "windsurf"), join(appData, "Windsurf")],
    userTargets: [
      {
        configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
        serversKey: "mcpServers",
      },
    ],
  });
}

registerWindsurfProfile();
