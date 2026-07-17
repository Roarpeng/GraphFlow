import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerClineProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "cline",
    name: "Cline",
    markerPaths: [
      join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
      join(appData, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev"),
      join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
    ],
    userTargets: [
      {
        configPath: isWindows()
          ? join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
          : join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: isWindows()
          ? join(appData, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
          : join(home, ".config", "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
        serversKey: "mcpServers",
      },
    ],
  });
}

registerClineProfile();
