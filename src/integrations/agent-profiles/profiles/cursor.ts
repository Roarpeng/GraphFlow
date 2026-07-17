import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerCursorProfile(): void {
  const { home, appData, localAppData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "cursor",
    name: "Cursor",
    markerPaths: [
      join(home, ".cursor"),
      join(appData, "Cursor"),
      join(localAppData, "Programs", "cursor"),
      join(localAppData, "cursor"),
    ],
    userTargets: [
      { configPath: join(home, ".cursor", "mcp.json"), serversKey: "mcpServers" },
      {
        configPath: join(appData, "Cursor", "User", "globalStorage", "roval.cursor", "mcp.json"),
        serversKey: "mcpServers",
      },
    ],
    workspaceRelativePaths: [{ relativePath: join(".cursor", "mcp.json"), serversKey: "mcpServers" }],
  });
}

registerCursorProfile();
