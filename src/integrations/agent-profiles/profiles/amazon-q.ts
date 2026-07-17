import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerAmazonQProfile(): void {
  const { home } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "amazon-q",
    name: "Amazon Q",
    markerPaths: [join(home, ".amazonq")],
    userTargets: [
      { configPath: join(home, ".amazonq", "mcp.json"), serversKey: "mcpServers" },
    ],
  });
}

registerAmazonQProfile();
