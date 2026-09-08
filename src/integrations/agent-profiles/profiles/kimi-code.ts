import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";
import { resolveKimiCodeHome } from "../../kimi-code-paths";

export function registerKimiCodeProfile(): void {
  const { home } = resolveHomePaths();
  const kimiHome = resolveKimiCodeHome();

  profileRegistry.registerProfile({
    id: "kimi-code",
    name: "Kimi Code",
    markerPaths: [kimiHome, join(home, ".kimi-code")],
    userTargets: [
      { configPath: join(kimiHome, "mcp.json"), serversKey: "mcpServers" },
    ],
    workspaceRelativePaths: [
      { relativePath: join(".kimi-code", "mcp.json"), serversKey: "mcpServers" },
    ],
  });
}

registerKimiCodeProfile();
