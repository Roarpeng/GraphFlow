import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CliOptions {
  command?: string;
  args: string[];
  json: boolean;
  configPath?: string;
}

export interface CliCommandResult {
  command: string;
  data: unknown;
  legacyText?: string;
}

export function buildCliUsage(): string {
  return [
    "Usage: graphflow <command> [options]",
    "Commands:",
    "  install                     Install MCP + Skill to all detected agents",
    "  uninstall                   从所有 agent 中移除 GraphFlow MCP 配置和 Skill 文件",
    "  mcp remove [--agent <name>] 从指定 agent 中移除 GraphFlow MCP 配置（支持 --agent 参数）",
    "  config init [--global]",
    "  config validate [--json] [--config <path>]",
    '  run "<task>" [--json] [--config <path>]',
    '  plan "<task>" [--json] [--config <path>]',
    '  plan insight "<task>" [--json] [--config <path>]',
    '  context preview "<query>" [--json] [--config <path>]',
    "  graph index [path] [--json] [--config <path>]",
    "  graph file <path> [--json] [--config <path>]",
    "  graph rebuild [path] [--json] [--config <path>]",
    "  graph inspect [--json] [--config <path>]",
    "  graph enrich [--json] [--config <path>]",
    "  artifact export [path] [--no-compress] [--json] [--config <path>]",
    "  artifact import [path] [--json] [--config <path>]",
    "  stats [--json] [--config <path>]",
    "  stats reset [--json] [--config <path>]",
    "  metrics [--json] [--config <path>]",
    "  model download [name] [--json] [--config <path>]",
    "  skill insights [--json] [--config <path>]",
    "  skill export [path] [--json] [--config <path>]",
    "  skill import [path] [--json] [--config <path>]",
    "  route diagnose [--json] [--config <path>]",
    "  learn nightly [--json] [--config <path>]",
    "  help | --help | -h",
    "  version | --version | -v",
  ].join("\n");
}

export function getCliVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")
    ) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function parseCliOptions(argv: string[]): CliOptions {
  const args: string[] = [];
  let json = false;
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (current === "--json") {
      json = true;
      continue;
    }

    if (current === "--config") {
      const next = argv[index + 1];
      if (next) {
        configPath = next;
        index += 1;
      }
      continue;
    }

    args.push(current);
  }

  return {
    ...(args[0] ? { command: args[0] } : {}),
    args: args.slice(1),
    json,
    ...(configPath ? { configPath } : {}),
  };
}

export function formatCliResult(result: CliCommandResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result.data, null, 2);
  }

  return result.legacyText ?? String(result.data);
}
