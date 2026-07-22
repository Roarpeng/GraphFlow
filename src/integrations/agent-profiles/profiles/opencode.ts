import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerOpencodeProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "opencode",
    name: "Opencode",
    markerPaths: [
      join(home, ".config", "opencode"),
      join(appData, "opencode"),
    ],
    userTargets: [
      {
        configPath: join(home, ".config", "opencode", "opencode.json"),
        serversKey: "mcp",
        configFormat: "opencode",
      },
    ],
    workspaceRelativePaths: [
      { relativePath: join(".opencode", "opencode.json"), serversKey: "mcp", configFormat: "opencode" },
    ],
  });
}

registerOpencodeProfile();
