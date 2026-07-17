import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerQoderProfile(): void {
  const { home, appData, localAppData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "qoder",
    name: "Qoder",
    markerPaths: [
      join(home, ".qoder"),
      join(appData, "Qoder"),
      join(localAppData, "Programs", "qoder"),
    ],
    userTargets: [
      {
        configPath: join(home, ".qoder", "mcp.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: isWindows()
          ? join(appData, "Qoder", "User", "mcp.json")
          : join(home, ".config", "Qoder", "User", "mcp.json"),
        serversKey: "mcpServers",
      },
    ],
    workspaceRelativePaths: [{ relativePath: join(".qoder", "mcp.json"), serversKey: "mcpServers" }],
  });
}

registerQoderProfile();
