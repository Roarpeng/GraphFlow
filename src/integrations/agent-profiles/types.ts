export type McpServersKey = "mcpServers" | "servers" | "context_servers";

export type McpConfigFormat = "json" | "codex-toml";

export interface McpServerTarget {
  configPath: string;
  serversKey: McpServersKey;
  configFormat?: McpConfigFormat;
}

export interface WorkspaceServerTarget {
  relativePath: string;
  serversKey: McpServersKey;
  configFormat?: McpConfigFormat;
}

export interface AgentProfile {
  id: string;
  name: string;
  markerPaths: string[];
  userTargets: McpServerTarget[];
  workspaceRelativePaths?: WorkspaceServerTarget[];
}

export interface AgentSkillTarget {
  agent: string;
  markerDir: string;
  skillsRoot: string;
}

export interface ProfileRegistry {
  registerProfile(profile: AgentProfile): void;
  registerSkillTarget(target: AgentSkillTarget): void;
  getProfiles(): AgentProfile[];
  getSkillTargets(): AgentSkillTarget[];
}
