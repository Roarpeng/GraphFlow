#!/usr/bin/env node
/**
 * GraphFlow 3.1 — Pure Token-First Surgical CLI (`src/cli.ts`)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { interceptPostToolUse, interceptPreToolUse } from "./host-interceptor.js";
import { PACKAGE_VERSION } from "./mcp-server.js";
import { executeV3ToolCall } from "./mcp-tools.js";

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function mergeJsonFile(filePath: string, mutator: (obj: Record<string, unknown>) => void): boolean {
  let current: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      current = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  mutator(current);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return true;
}

function installHostConfigs(rootDir: string, home: string = homedir()): void {
  const mcpTargets = [
    join(home, ".cursor", "mcp.json"),
    join(home, ".claude.json"),
    join(rootDir, ".cursor", "mcp.json"),
  ];
  let updatedCount = 0;
  for (const target of mcpTargets) {
    if (target.startsWith(home) && !existsSync(dirname(target))) continue;
    const ok = mergeJsonFile(target, (obj) => {
      const servers =
        obj.mcpServers && typeof obj.mcpServers === "object"
          ? (obj.mcpServers as Record<string, unknown>)
          : {};
      servers.graphflow = {
        command: "npx",
        args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      };
      obj.mcpServers = servers;
    });
    if (ok) updatedCount += 1;
  }

  const claudeSettings = join(home, ".claude", "settings.json");
  if (existsSync(join(home, ".claude"))) {
    mergeJsonFile(claudeSettings, (obj) => {
      const hooks =
        obj.hooks && typeof obj.hooks === "object" ? (obj.hooks as Record<string, unknown>) : {};
      hooks.PreToolUse = [{ type: "command", command: "graphflow hook pre-tool", timeout: 15 }];
      hooks.PostToolUse = [{ type: "command", command: "graphflow hook post-tool", timeout: 15 }];
      obj.hooks = hooks;
    });
  }

  const cursorHooks = join(home, ".cursor", "hooks.json");
  if (existsSync(join(home, ".cursor"))) {
    mergeJsonFile(cursorHooks, (obj) => {
      obj.version = 1;
      const hooks =
        obj.hooks && typeof obj.hooks === "object" ? (obj.hooks as Record<string, unknown>) : {};
      hooks.preToolUse = [{ command: "graphflow hook pre-tool", timeout: 15 }];
      hooks.postToolUse = [{ command: "graphflow hook post-tool", timeout: 15 }];
      obj.hooks = hooks;
    });
  }
  console.log(
    `GraphFlow v${PACKAGE_VERSION} installed (${updatedCount} MCP config(s) + PreToolUse/PostToolUse hooks).`
  );
}

function printUsage(): void {
  console.log(
    [
      `GraphFlow v${PACKAGE_VERSION} — Token-First Surgical Code Engine`,
      "",
      "Usage:",
      "  graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]",
      "  graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <newName>]",
      "  graphflow exec [cmd] [--run]",
      "  graphflow macro <list|run|mine|mine-git|save> [id] [args...]",
      "  graphflow hook <pre-tool|post-tool>",
      "  graphflow install",
      "  graphflow version | help",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0]?.trim() ?? "help";
  const rest = argv.slice(1);
  const rootDir = readFlag(rest, "--root") ?? process.cwd();

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  if (cmd === "hook") {
    const sub = rest[0]?.trim() ?? "pre-tool";
    let rawStdin = "";
    try {
      rawStdin = readFileSync(0, "utf8");
    } catch {
      rawStdin = "{}";
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawStdin || "{}") as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const hookRoot = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : rootDir;
    if (sub === "pre-tool" || sub === "PreToolUse" || sub === "preToolUse") {
      const res = interceptPreToolUse(
        payload as unknown as Parameters<typeof interceptPreToolUse>[0],
        { rootDir: hookRoot }
      );
      process.stdout.write(`${JSON.stringify(res.hookProtocolOutput)}\n`);
      return;
    }
    if (sub === "post-tool" || sub === "PostToolUse" || sub === "postToolUse") {
      const res = interceptPostToolUse(
        payload as unknown as Parameters<typeof interceptPostToolUse>[0],
        { rootDir: hookRoot }
      );
      process.stdout.write(`${JSON.stringify(res.hookProtocolOutput)}\n`);
      return;
    }
    process.stdout.write("{}\n");
    return;
  }

  if (cmd === "read" || cmd === "gf-read") {
    const q = readFlag(rest, "-q") ?? readFlag(rest, "--query");
    const skeleton = rest.includes("--skeleton");
    const dedup = rest.includes("--dedup");
    const targets = rest.filter(
      (a, i) =>
        !a.startsWith("-") &&
        rest[i - 1] !== "-q" &&
        rest[i - 1] !== "--query" &&
        rest[i - 1] !== "--root"
    );
    const res = executeV3ToolCall(
      "gf_read",
      {
        ...(targets.length > 0 ? { targets } : {}),
        ...(q ? { q } : {}),
        skeleton,
        dedup,
        rootDir,
      },
      rootDir
    );
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "edit" || cmd === "gf-edit") {
    const file = rest[0] ?? "";
    const symbol = readFlag(rest, "--symbol");
    const newCode = readFlag(rest, "--new");
    const oldCode = readFlag(rest, "--old");
    const renameTo = readFlag(rest, "--rename");
    const res = executeV3ToolCall(
      "gf_edit",
      {
        file,
        ...(symbol ? { symbol } : {}),
        ...(newCode !== undefined ? { newCode } : {}),
        ...(oldCode !== undefined ? { oldCode } : {}),
        ...(renameTo ? { renameTo } : {}),
        rootDir,
      },
      rootDir
    );
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "exec" || cmd === "gf-exec") {
    const run = rest.includes("--run");
    const positional = rest.filter((a) => !a.startsWith("-"));
    const execCmd = positional.length > 0 ? positional.join(" ") : "affected-tests";
    const res = executeV3ToolCall("gf_exec", { cmd: execCmd, run, rootDir }, rootDir);
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "macro" || cmd === "gf-macro") {
    const action = rest[0] ?? "list";
    const id = rest[1];
    const macroArgs = rest.slice(2).filter((a) => !a.startsWith("-"));
    const res = executeV3ToolCall(
      "gf_macro",
      {
        action,
        ...(id ? { id } : {}),
        ...(macroArgs.length > 0 ? { args: macroArgs } : {}),
        rootDir,
      },
      rootDir
    );
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "install" || cmd === "init") {
    installHostConfigs(rootDir);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("GraphFlow CLI error:", err);
  process.exitCode = 1;
});
