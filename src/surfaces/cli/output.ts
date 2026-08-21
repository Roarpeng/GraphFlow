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
    "  install [--json]            Install MCP + Skill to all detected agents",
    "  doctor [--json]             自检：列出各 agent 的 MCP 与指令文件注册状态",
    "  uninstall                   移除 MCP + Skill + Rules + hooks（插件卸后请再跑此命令）",
    "  mcp remove [--agent <name>] 从指定 agent 中移除 GraphFlow MCP 配置（支持 --agent 参数）",
    "  learn nightly [--json]      Run nightly learning loop",
    "  config init [--global]",
    "  config validate [--json] [--config <path>]",
    '  run "<task>" [--json] [--config <path>]',
    "  outcome report <episodeId> <success> [--lesson <text>]... [--deviation <none|misread-requirement|scope-creep|tech-drift>] [--requirement-id <id>]... [--concept-id <id>]... [--code-hint <path|symbol|id>]... [--json] [--config <path>]",
    '  insight submit --task "<task>" --work-item-id <id> --response "<json>" [--episode-id <id>] [--json] [--config <path>]',
    '  insight merge --task "<task>" [--json] [--config <path>]',
    '  plan "<task>" [--json] [--config <path>]',
    '  plan insight "<task>" [--json] [--config <path>]',
    '  context preview "<query>" [--json] [--config <path>]',
    "  graph index [path] [--json] [--config <path>]",
    "  graph file <path> [--json] [--config <path>]",
    "  graph rebuild [path] [--json] [--config <path>]",
    "  graph inspect [--json] [--config <path>]",
    "  workbench tree [--json] [--config <path>]  # on-demand function DAG + side branches; click topicId to resume",
    "  artifact export [path] [--no-compress] [--include-episodes] [--json] [--config <path>]",
    "  artifact export-memory [dir] [--json] [--config <path>]  # Markdown experience pack (skills + episodes) → graphflow-out/memory-pack/",
    "  artifact import [path] [--json] [--config <path>]",
    "  stats [--json] [--config <path>]",
    "  stats reset [--json] [--config <path>]",
    "  skill insights [--json] [--config <path>]",
    "  skill export [path] [--json] [--config <path>]",
    "  skill import [path] [--json] [--config <path>]",
    "  skill sync <export|import> [--path <file>] [--force]  # git-committable team skill package (.graphflow/skills/team-skills.json); import MERGES (newer updatedAt wins, ties keep local, --force overwrites); golden queries -> .graphflow/team-golden.json",
    "  skill report [--json] [--config <path>]  # flywheel contribution: skills health + episode outcomes",
    "  skill decay [--json] [--config <path>]",
    "  skill reset --name <name> [--json] [--config <path>]",
    "  skill prune [--json] [--config <path>]",
    "  skill consolidate [--apply|--execute] [--json] [--config <path>]  # dry-run QM plan (UPDATE/DELETE/ADD); --apply/--execute mutates graph",
    "  route diagnose [--json] [--config <path>]",
    "  learn nightly [--json] [--config <path>]",
    "  learn forget [--json] [--config <path>]",
    "  memory list [--limit N] [--outcome pass|fail|pending] [--json] [--config <path>]  # audit episodic memory: evidence records (id, task, outcome, lessons, staleGoal, updatedAt) sorted by updatedAt desc",
    '  memory search "<query>" [--limit N] [--json] [--config <path>]  # semantic similarity over episodes (FNV fallback); per-hit id, task, score, outcome',
    "  memory forget <episodeId> [--json] [--config <path>]  # prune episode + hide descendant skills; unknown id is a clean no-op",
    "  dialogue list [--session <name|id>] [--limit N] [--json] [--config <path>]  # list conversation-turn graph nodes",
    '  dialogue record --query "<text>" [--reply "<text>"] [--resume-from <turnId>] [--session <name>] [--json] [--config <path>]',
    "  dialogue distill [--all] [--session <name|id>] [--json] [--config <path>]  # backfill turn titles/summaries (offline)",
    "  help | --help | -h",
    "  version | --version | -v",
  ].join("\n");
}

/** Parse bridge outcome success tokens (true/false/pass/fail/1/0/yes/no). */
export function parseCliSuccess(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (["true", "1", "pass", "success", "yes", "y"].includes(value)) {
    return true;
  }
  if (["false", "0", "fail", "failed", "no", "n"].includes(value)) {
    return false;
  }
  return undefined;
}

/** Collect all values for a repeated CLI flag (e.g. --lesson a --lesson b). */
export function collectCliFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        values.push(next);
        index += 1;
      }
    }
  }
  return values;
}

/** Read the first value for a CLI flag; supports `--flag=value` and `--flag value`. */
export function readCliFlagValue(args: string[], flag: string): string | undefined {
  const eqPrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current) {
      continue;
    }
    if (current.startsWith(eqPrefix)) {
      const value = current.slice(eqPrefix.length).trim();
      return value.length > 0 ? value : undefined;
    }
    if (current === flag) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        return next;
      }
      return undefined;
    }
  }
  return undefined;
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
