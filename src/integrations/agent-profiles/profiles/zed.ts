import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerZedProfile(): void {
  const { home, appData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "zed",
    name: "Zed",
    markerPaths: [
      join(home, ".config", "zed"),
      isWindows() ? join(appData, "Zed") : undefined,
    ].filter(Boolean) as string[],
    userTargets: [
      {
        configPath: isWindows()
          ? join(appData, "Zed", "settings.json")
          : join(home, ".config", "zed", "settings.json"),
        serversKey: "context_servers",
      },
    ],
  });
}

registerZedProfile();
