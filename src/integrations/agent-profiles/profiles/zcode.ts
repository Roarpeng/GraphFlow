import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerZcodeProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "zcode",
    name: "ZCode",
    markerPaths: [
      join(home, ".zcode"),
      join(appData, "zcode"),
    ],
    userTargets: [
      {
        configPath: join(home, ".zcode", "cli", "config.json"),
        serversKey: "mcpServers",
        configFormat: "zcode",
      },
    ],
    workspaceRelativePaths: [
      { relativePath: join(".zcode", "config.json"), serversKey: "mcpServers", configFormat: "zcode" },
    ],
  });
}

registerZcodeProfile();
