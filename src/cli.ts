#!/usr/bin/env node
/**
 * GraphFlow 3.1 — Pure Token-First Surgical CLI (`src/cli.ts`)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  detectInstalledAgents,
  installAllAgents,
  uninstallAllAgents,
} from "./agent-installer.js";
import { interceptPostToolUse, interceptPreToolUse } from "./host-interceptor.js";
import { PACKAGE_VERSION } from "./mcp-server.js";
import { executeV3ToolCall } from "./mcp-tools.js";

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function printUsage(): void {
  console.log(
    [
      `GraphFlow v${PACKAGE_VERSION} — Token-First Surgical Code Engine`,
      "",
      "Usage:",
      "  graphflow install [--workspace] [--agents <id1,id2>] [--no-prune]",
      "  graphflow uninstall",
      "  graphflow status",
      "  graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]",
      "  graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <newName>]",
      "  graphflow exec [cmd] [--run]",
      "  graphflow macro <list|run|mine|mine-git|save> [id] [args...]",
      "  graphflow hook <pre-tool|post-tool>",
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

  if (cmd === "install" || cmd === "init") {
    const includeWorkspace = rest.includes("--workspace") || rest.includes("--all");
    const agentsCsv = readFlag(rest, "--agents");
    const agentIds = agentsCsv
      ? agentsCsv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const report = installAllAgents({
      workspaceRoot: rootDir,
      includeWorkspace,
      ...(agentIds ? { agentIds } : {}),
      ...(rest.includes("--no-prune") ? { pruneLegacy: false } : {}),
    });
    const mcpCount = report.results.filter((r) => r.category === "mcp" && r.status !== "error").length;
    const skillCount = report.results.filter((r) => r.category === "skill" && r.status !== "error").length;
    const ruleCount = report.results.filter((r) => r.category === "rule" && r.status !== "error").length;
    const hookCount = report.results.filter((r) => r.category === "hook" && r.status !== "error").length;
    console.log(
      `GraphFlow v${PACKAGE_VERSION} installed across ${report.detectedAgents.length} detected agent(s): ` +
        `MCP=${mcpCount}, Skills=${skillCount}, Rules=${ruleCount}, Hooks=${hookCount}`
    );
    for (const item of report.results) {
      console.log(`  [${item.status.toUpperCase()}] (${item.category}) ${item.agentName} -> ${item.targetPath}`);
    }
    return;
  }

  if (cmd === "uninstall") {
    const removed = uninstallAllAgents({ workspaceRoot: rootDir });
    console.log(`GraphFlow v${PACKAGE_VERSION} uninstalled (${removed.length} item(s) removed).`);
    for (const item of removed) {
      console.log(`  [REMOVED] (${item.category}) ${item.agentName} -> ${item.targetPath}`);
    }
    return;
  }

  if (cmd === "status" || cmd === "doctor") {
    const detected = detectInstalledAgents();
    console.log(
      `GraphFlow v${PACKAGE_VERSION} — Detected ${detected.length} coding agent(s): ` +
        (detected.map((d) => `${d.name} (${d.id})`).join(", ") || "none")
    );
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
    // The hook payload's cwd may be any subdirectory of the workspace; walk up
    // to the nearest ancestor that already owns a `.graphflow` store so events
    // land in the workspace root instead of spawning scattered stores.
    const resolveHookRoot = (startDir: string): string => {
      let dir = startDir;
      for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, ".graphflow"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return startDir;
    };
    const hookRoot = resolveHookRoot(
      typeof payload.cwd === "string" && payload.cwd ? payload.cwd : rootDir
    );
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

  if (cmd === "graph" || cmd === "visualize") {
    const res = executeV3ToolCall("gf_macro", { action: "visualize", rootDir }, rootDir);
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "brief") {
    const res = executeV3ToolCall("gf_macro", { action: "brief", rootDir }, rootDir);
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

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("GraphFlow CLI error:", err);
  process.exitCode = 1;
});
