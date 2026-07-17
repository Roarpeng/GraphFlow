import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerVscodeProfile(): void {
  const { home, appData, localAppData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "vscode",
    name: "VS Code",
    markerPaths: [
      join(appData, "Code"),
      join(localAppData, "Programs", "Microsoft VS Code"),
      join(home, ".vscode"),
    ],
    userTargets: [
      {
        configPath: isWindows()
          ? join(appData, "Code", "User", "mcp.json")
          : join(home, ".config", "Code", "User", "mcp.json"),
        serversKey: "servers",
      },
    ],
    workspaceRelativePaths: [{ relativePath: join(".vscode", "mcp.json"), serversKey: "servers" }],
  });
}

registerVscodeProfile();
