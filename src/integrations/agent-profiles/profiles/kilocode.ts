import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerKiloCodeProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "kilocode",
    name: "Kilo Code",
    markerPaths: [
      join(appData, "Code", "User", "globalStorage", "kilocode.kilocode-ai"),
      join(appData, "Cursor", "User", "globalStorage", "kilocode.kilocode-ai"),
      join(home, ".config", "Code", "User", "globalStorage", "kilocode.kilocode-ai"),
    ],
    userTargets: [
      {
        configPath: isWindows()
          ? join(appData, "Code", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json")
          : join(home, ".config", "Code", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: isWindows()
          ? join(appData, "Cursor", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json")
          : join(home, ".config", "Cursor", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json"),
        serversKey: "mcpServers",
      },
    ],
  });
}

registerKiloCodeProfile();
