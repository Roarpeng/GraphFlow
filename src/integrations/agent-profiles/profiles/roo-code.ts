import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerRooCodeProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "roo-code",
    name: "Roo Code",
    markerPaths: [
      join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
      join(appData, "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
      join(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
    ],
    userTargets: [
      {
        configPath: isWindows()
          ? join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
          : join(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
        serversKey: "mcpServers",
      },
      {
        configPath: isWindows()
          ? join(appData, "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
          : join(home, ".config", "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
        serversKey: "mcpServers",
      },
    ],
  });
}

registerRooCodeProfile();
