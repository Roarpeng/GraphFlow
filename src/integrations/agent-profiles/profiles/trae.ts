import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerTraeProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "trae",
    name: "Trae",
    markerPaths: [
      join(home, ".trae"),
      join(home, ".trae-cn"),
      join(home, ".trae-aicc"),
      join(appData, "Trae"),
      join(appData, "Trae CN"),
      join(appData, "TRAE SOLO CN"),
    ],
    userTargets: [
      {
        configPath: isWindows()
          ? join(appData, "Trae", "User", "mcp.json")
          : join(home, ".config", "Trae", "User", "mcp.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: isWindows()
          ? join(appData, "Trae CN", "User", "mcp.json")
          : join(home, ".config", "Trae CN", "User", "mcp.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: isWindows()
          ? join(appData, "TRAE SOLO CN", "User", "mcp.json")
          : join(home, ".config", "TRAE SOLO CN", "User", "mcp.json"),
        serversKey: "mcpServers",
      },
    ],
  });
}

registerTraeProfile();
