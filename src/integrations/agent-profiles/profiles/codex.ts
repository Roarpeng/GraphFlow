import { profileRegistry } from "../registry";
import { resolveHomePaths, join } from "../utils";

export function registerCodexProfile(): void {
  const { home, localAppData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "codex",
    name: "Codex",
    markerPaths: [join(home, ".codex"), join(localAppData, "OpenAI", "Codex")],
    userTargets: [
      {
        configPath: join(home, ".codex", "config.toml"),
        serversKey: "mcpServers",
        configFormat: "codex-toml",
      },
    ],
  });
}

registerCodexProfile();
