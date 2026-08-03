import { profileRegistry } from "../registry";
import { resolveHomePaths, join, isWindows } from "../utils";

export function registerQoderProfile(): void {
  const { home, appData, localAppData } = resolveHomePaths();

  profileRegistry.registerProfile({
    id: "qoder",
    name: "Qoder",
    markerPaths: [
      join(home, ".qoder"),
      join(home, ".qoder-cn"),
      join(home, ".config", "Qoder"),
      join(home, ".config", "QoderCN"),
      join(appData, "Qoder"),
      join(appData, "QoderCN"),
      join(localAppData, "Programs", "qoder"),
    ],
    userTargets: [
      {
        configPath: join(home, ".qoder", "mcp.json"),
        serversKey: "mcpServers",
      },
      {
        // Qoder 实际读取的用户级 MCP 配置（国际版，已实测生效）
        configPath: isWindows()
          ? join(appData, "Qoder", "SharedClientCache", "mcp.json")
          : join(home, ".config", "Qoder", "SharedClientCache", "mcp.json"),
        serversKey: "mcpServers",
      },
      {
        // Qoder CN 版实际读取的用户级 MCP 配置（已实测生效）
        configPath: isWindows()
          ? join(appData, "QoderCN", "SharedClientCache", "mcp.json")
          : join(home, ".config", "QoderCN", "SharedClientCache", "mcp.json"),
        serversKey: "mcpServers",
      },
    ],
    workspaceRelativePaths: [{ relativePath: join(".qoder", "mcp.json"), serversKey: "mcpServers" }],
  });
}

registerQoderProfile();
