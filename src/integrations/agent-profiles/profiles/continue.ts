import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerContinueProfile(): void {
  const { home } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "continue",
    name: "Continue",
    markerPaths: [
      join(home, ".continue"),
    ],
    userTargets: [
      {
        configPath: join(home, ".continue", "config.json"),
        serversKey: "mcpServers",
      },
    ],
  });
}

registerContinueProfile();
