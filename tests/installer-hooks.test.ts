/**
 * GraphFlow — host hook merge/removal + registration status tests.
 *
 * Covers the "removes everything cleanly" promise:
 *  - installHostHook MERGES into user hook arrays (never overwrites),
 *  - reinstall is idempotent (no duplicate graphflow entries),
 *  - uninstall removes only graphflow-owned hooks and keeps user hooks,
 *  - getAgentRegistrationStatus reports mcp/skill/rule/hook before/after
 *    install and uninstall (including DSH Cordis patch detection),
 *  - JSON configs stay valid throughout.
 *
 * Every sandbox (home / AppData / LocalAppData / workspace / DSH_HOME) is a
 * fresh mkdtemp directory passed through installer options; the real HOME and
 * real ~/.dsh are never touched.
 *
 * Standalone: `npx tsx tests/installer-hooks.test.ts`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAgentRegistrationStatus,
  installAllAgents,
  removeHostHook,
  uninstallAllAgents,
  type AgentInstallItemResult,
  type InstallAllAgentsOptions,
  type InstallAllAgentsReport,
  type UninstallAllAgentsOptions,
} from "../src/agent-installer.js";
import { formatRegistrationStatusLine } from "../src/cli.js";

const failures: string[] = [];
let checks = 0;

function check(name: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface Sandbox {
  root: string;
  home: string;
  appData: string;
  localAppData: string;
  workspace: string;
  dshHome: string;
  cordisPath: string;
  dshMcpPath: string;
  cursorHooks: string;
  cursorMcp: string;
  claudeHooks: string;
  claudeMcp: string;
  codexHooks: string;
  geminiHooks: string;
  baseOptions: () => InstallAllAgentsOptions;
  install: (extra?: Partial<InstallAllAgentsOptions>) => InstallAllAgentsReport;
  uninstall: (extra?: Partial<UninstallAllAgentsOptions>) => AgentInstallItemResult[];
  cleanup: () => void;
}

function createSandbox(includeDsh = false): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "gf-hooks-"));
  const home = join(root, "home");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  const workspace = join(root, "workspace");
  const dshHome = join(root, "dsh-home");
  // Detected-host markers for the four hook-capable agents.
  for (const dir of [home, appData, localAppData, workspace]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const marker of [".cursor", ".claude", ".codex", ".gemini"]) {
    mkdirSync(join(home, marker), { recursive: true });
  }
  if (includeDsh) mkdirSync(dshHome, { recursive: true });
  const baseOptions = (): InstallAllAgentsOptions => ({
    homeDir: home,
    appDataDir: appData,
    localAppDataDir: localAppData,
    workspaceRoot: workspace,
    dshHome,
  });
  return {
    root,
    home,
    appData,
    localAppData,
    workspace,
    dshHome,
    cordisPath: join(dshHome, "cordis.patch.yml"),
    dshMcpPath: join(dshHome, "mcp.json"),
    cursorHooks: join(home, ".cursor", "hooks.json"),
    cursorMcp: join(home, ".cursor", "mcp.json"),
    claudeHooks: join(home, ".claude", "settings.json"),
    claudeMcp: join(home, ".claude.json"),
    codexHooks: join(home, ".codex", "hooks.json"),
    geminiHooks: join(home, ".gemini", "settings.json"),
    baseOptions,
    install: (extra = {}) => installAllAgents({ ...baseOptions(), ...extra }),
    uninstall: (extra = {}) => uninstallAllAgents({ ...baseOptions(), ...extra }),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const ALL_HOOK_AGENTS = ["cursor", "claude-code", "codex", "gemini"];

/** Pre-seed user hooks (plus a stale graphflow entry for Cursor / a mixed one for Claude). */
function seedUserHooks(s: Sandbox): void {
  writeJson(s.cursorHooks, {
    version: 1,
    custom: "keep-me",
    hooks: {
      preToolUse: [
        { command: "user-cursor-pre", timeout: 5 },
        { command: "npx graphflow hook pre-tool --legacy", timeout: 9 },
      ],
      postToolUse: [{ command: "user-cursor-post", timeout: 5 }],
      sessionStart: [{ command: "user-cursor-session" }],
    },
  });
  writeJson(s.claudeHooks, {
    model: "opus",
    hooks: {
      PreToolUse: [
        { matcher: "Write", hooks: [{ type: "command", command: "user-claude-pre" }] },
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "graphflow hook pre-tool" },
            { type: "command", command: "user-claude-mixed" },
          ],
        },
      ],
      PostToolUse: [
        { matcher: "Edit", hooks: [{ type: "command", command: "user-claude-post" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "user-claude-stop" }] }],
    },
  });
  writeJson(s.codexHooks, {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "user-codex-pre", timeout: 3 }] },
      ],
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "user-codex-post", timeout: 3 }] },
      ],
    },
  });
  writeJson(s.geminiHooks, {
    theme: "dark",
    hooks: {
      BeforeTool: [
        {
          matcher: "Read",
          hooks: [{ name: "user-gemini", type: "command", command: "user-gemini-pre" }],
        },
      ],
      AfterTool: [],
    },
  });
}

function hookCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const commands: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.command === "string") commands.push(record.command);
    if (Array.isArray(record.hooks)) {
      for (const nested of record.hooks) {
        if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).command === "string") {
          commands.push((nested as Record<string, unknown>).command as string);
        }
      }
    }
  }
  return commands;
}

function countGraphflowCommands(value: unknown): number {
  return hookCommands(value).filter((command) => command.toLowerCase().includes("graphflow hook")).length;
}

// ---------------------------------------------------------------------------
// 1. Install merges graphflow hooks into pre-seeded user hook files.
// ---------------------------------------------------------------------------
check("install merges graphflow hooks and preserves user hooks (cursor/claude/codex/gemini)", () => {
  const s = createSandbox();
  try {
    seedUserHooks(s);
    const report = s.install();
    assert.equal(
      report.results.filter((r) => r.category === "hook").length,
      ALL_HOOK_AGENTS.length,
      "each detected host with hooks must be installed"
    );

    // ---- Cursor: flat {command, timeout} arrays; stale graphflow entry replaced.
    const cursor = readJson(s.cursorHooks);
    const cursorHooks = cursor.hooks as Record<string, unknown>;
    const cursorPre = cursorHooks.preToolUse as unknown[];
    assert.equal(cursorPre.length, 2, "user pre hook + exactly one graphflow hook");
    assert.ok(
      (cursorPre as Array<Record<string, unknown>>).some((h) => h.command === "user-cursor-pre")
    );
    assert.ok(
      (cursorPre as Array<Record<string, unknown>>).some(
        (h) => h.command === "graphflow hook pre-tool" && h.timeout === 15
      )
    );
    assert.equal(countGraphflowCommands(cursorPre), 1, "stale graphflow cursor hook replaced, not duplicated");
    assert.ok((cursorHooks.postToolUse as unknown[]).length === 2);
    assert.ok(Array.isArray(cursorHooks.sessionStart), "unrelated cursor hook phase preserved");
    assert.equal(cursor.custom, "keep-me");
    assert.equal(cursor.version, 1);

    // ---- Claude Code: nested matcher/hooks entries.
    const claude = readJson(s.claudeHooks);
    const claudeHooks = claude.hooks as Record<string, unknown>;
    const claudePre = claudeHooks.PreToolUse as Array<Record<string, unknown>>;
    assert.equal(claudePre.length, 3, "Write entry + mixed entry + graphflow entry");
    assert.ok(claudePre.some((entry) => entry.matcher === "Write"));
    const mixed = claudePre.find((entry) => entry.matcher === "Bash");
    assert.ok(mixed, "user matcher entry preserved");
    assert.deepEqual(
      (mixed.hooks as Array<Record<string, unknown>>).map((h) => h.command),
      ["user-claude-mixed"],
      "graphflow nested hook removed from a mixed entry, user nested hook kept"
    );
    assert.ok(claudePre.some((entry) => countGraphflowCommands(entry.hooks) === 1));
    assert.equal(countGraphflowCommands(claudePre), 1);
    assert.equal((claudeHooks.PostToolUse as unknown[]).length, 2);
    assert.ok(Array.isArray(claudeHooks.Stop), "user Stop phase preserved");
    assert.equal(claude.model, "opus");

    // ---- Codex: Claude-like nested shape in ~/.codex/hooks.json.
    const codex = readJson(s.codexHooks);
    const codexHooks = codex.hooks as Record<string, unknown>;
    const codexPre = codexHooks.PreToolUse as Array<Record<string, unknown>>;
    assert.equal(codexPre.length, 2);
    assert.ok(codexPre.some((entry) => countGraphflowCommands(entry.hooks) === 1));
    assert.ok(hookCommands(codexPre).includes("user-codex-pre"));
    assert.equal(countGraphflowCommands(codexPre), 1);
    assert.equal(countGraphflowCommands(codexHooks.PostToolUse), 1);

    // ---- Gemini: named nested hooks; settings file also carries the MCP entry.
    const gemini = readJson(s.geminiHooks);
    const geminiHooks = gemini.hooks as Record<string, unknown>;
    const geminiBefore = geminiHooks.BeforeTool as Array<Record<string, unknown>>;
    assert.equal(geminiBefore.length, 2);
    assert.ok(hookCommands(geminiBefore).includes("user-gemini-pre"));
    assert.ok(hookCommands(geminiBefore).includes("graphflow hook pre-tool"));
    assert.equal(countGraphflowCommands(geminiBefore), 1);
    assert.equal(countGraphflowCommands(geminiHooks.AfterTool), 1);
    assert.equal(gemini.theme, "dark", "unrelated Gemini settings key preserved");
    assert.ok(
      (gemini.mcpServers as Record<string, unknown> | undefined)?.graphflow,
      "Gemini settings.json keeps both the MCP entry and the merged hooks"
    );
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Reinstall is idempotent: no duplicate graphflow hooks, files unchanged.
// ---------------------------------------------------------------------------
check("reinstall is idempotent (no duplicate graphflow hooks)", () => {
  const s = createSandbox();
  try {
    seedUserHooks(s);
    s.install();
    const snapshot = {
      cursor: readFileSync(s.cursorHooks, "utf8"),
      claude: readFileSync(s.claudeHooks, "utf8"),
      codex: readFileSync(s.codexHooks, "utf8"),
      gemini: readFileSync(s.geminiHooks, "utf8"),
    };
    s.install();

    assert.equal(readFileSync(s.cursorHooks, "utf8"), snapshot.cursor, "cursor hooks byte-identical on reinstall");
    assert.equal(readFileSync(s.claudeHooks, "utf8"), snapshot.claude, "claude hooks byte-identical on reinstall");
    assert.equal(readFileSync(s.codexHooks, "utf8"), snapshot.codex, "codex hooks byte-identical on reinstall");
    assert.equal(readFileSync(s.geminiHooks, "utf8"), snapshot.gemini, "gemini settings byte-identical on reinstall");

    const cursorHooks = readJson(s.cursorHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(cursorHooks.preToolUse), 1);
    assert.equal(countGraphflowCommands(cursorHooks.postToolUse), 1);
    const claudeHooks = readJson(s.claudeHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(claudeHooks.PreToolUse), 1);
    assert.equal(countGraphflowCommands(claudeHooks.PostToolUse), 1);
    const geminiHooks = readJson(s.geminiHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(geminiHooks.BeforeTool), 1);
    assert.equal(countGraphflowCommands(geminiHooks.AfterTool), 1);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Uninstall removes graphflow hooks only, preserving user hooks + JSON.
// ---------------------------------------------------------------------------
check("uninstall removes graphflow hooks only, keeps user hooks and valid JSON", () => {
  const s = createSandbox();
  try {
    seedUserHooks(s);
    s.install();
    const removed = s.uninstall({ agentIds: ALL_HOOK_AGENTS });

    const hookRemovals = removed.filter((r) => r.category === "hook" && r.status === "removed");
    assert.equal(hookRemovals.length, ALL_HOOK_AGENTS.length, "hook removal reported for every host");
    for (const hookPath of [s.cursorHooks, s.claudeHooks, s.codexHooks, s.geminiHooks]) {
      assert.ok(
        hookRemovals.some((r) => r.targetPath === hookPath),
        `hook removal reported for ${hookPath}`
      );
      JSON.parse(readFileSync(hookPath, "utf8")); // still valid JSON
    }

    // Cursor: user hooks only; other phases/custom keys intact.
    const cursor = readJson(s.cursorHooks);
    const cursorHooks = cursor.hooks as Record<string, unknown>;
    assert.deepEqual(
      (cursorHooks.preToolUse as Array<Record<string, unknown>>).map((h) => h.command),
      ["user-cursor-pre"]
    );
    assert.deepEqual(
      (cursorHooks.postToolUse as Array<Record<string, unknown>>).map((h) => h.command),
      ["user-cursor-post"]
    );
    assert.ok(Array.isArray(cursorHooks.sessionStart));
    assert.equal(cursor.custom, "keep-me");
    assert.equal(countGraphflowCommands(cursorHooks.preToolUse), 0);

    // Claude: user matcher entries, mixed entry's user nested hook, Stop phase.
    const claude = readJson(s.claudeHooks);
    const claudeHooks = claude.hooks as Record<string, unknown>;
    assert.equal((claudeHooks.PreToolUse as unknown[]).length, 2, "Write entry + mixed entry remain");
    assert.deepEqual(
      hookCommands(claudeHooks.PreToolUse).sort(),
      ["user-claude-mixed", "user-claude-pre"]
    );
    assert.deepEqual(hookCommands(claudeHooks.PostToolUse), ["user-claude-post"]);
    assert.deepEqual(hookCommands(claudeHooks.Stop), ["user-claude-stop"]);
    assert.equal(claude.model, "opus");
    assert.equal(countGraphflowCommands(claudeHooks.PreToolUse), 0);

    // Codex / Gemini user hooks preserved; Gemini MCP entry also removed.
    const codexHooks = readJson(s.codexHooks).hooks as Record<string, unknown>;
    assert.deepEqual(hookCommands(codexHooks.PreToolUse), ["user-codex-pre"]);
    assert.deepEqual(hookCommands(codexHooks.PostToolUse), ["user-codex-post"]);
    const gemini = readJson(s.geminiHooks);
    const geminiHooks = gemini.hooks as Record<string, unknown>;
    assert.deepEqual(hookCommands(geminiHooks.BeforeTool), ["user-gemini-pre"]);
    assert.deepEqual(hookCommands(geminiHooks.AfterTool), []);
    assert.equal(gemini.theme, "dark");
    assert.ok(!("graphflow" in ((gemini.mcpServers as Record<string, unknown>) ?? {})));

    // Second uninstall: nothing graphflow-owned left to remove.
    const second = s.uninstall({ agentIds: ALL_HOOK_AGENTS });
    assert.equal(second.filter((r) => r.category === "hook").length, 0);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. removeHostHook is a safe standalone helper (exported).
// ---------------------------------------------------------------------------
check("removeHostHook removes only graphflow hooks and reports no-op when absent", () => {
  const s = createSandbox();
  try {
    writeJson(s.cursorHooks, {
      hooks: {
        preToolUse: [{ command: "user-pre" }, { command: "graphflow hook pre-tool", timeout: 15 }],
        postToolUse: [{ command: "graphflow hook post-tool", timeout: 15 }],
      },
    });
    assert.equal(removeHostHook("cursor", s.cursorHooks), true);
    const hooks = readJson(s.cursorHooks).hooks as Record<string, unknown>;
    assert.deepEqual((hooks.preToolUse as Array<Record<string, unknown>>).map((h) => h.command), ["user-pre"]);
    // An emptied phase is removed rather than left behind as `"postToolUse": []`.
    assert.equal(hooks.postToolUse, undefined);
    assert.equal(removeHostHook("cursor", s.cursorHooks), false, "second removal is a no-op");
    assert.equal(removeHostHook("cursor", join(s.root, "missing.json")), false);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. getAgentRegistrationStatus before / after install / after uninstall.
// ---------------------------------------------------------------------------
check("getAgentRegistrationStatus reflects mcp/skill/rule/hook before and after install/uninstall", () => {
  const s = createSandbox(true); // DSH profile dir exists so DSH is detected too
  try {
    const before = new Map(
      getAgentRegistrationStatus({ ...s.baseOptions() }).map((status) => [status.id, status])
    );
    for (const id of ALL_HOOK_AGENTS) {
      const status = before.get(id);
      assert.ok(status, `${id} is detected in the sandbox`);
      assert.equal(status.mcp, false, `${id} MCP not registered before install`);
      assert.equal(status.skill, false, `${id} skill not registered before install`);
      assert.equal(status.rule, false, `${id} rule not registered before install`);
      assert.equal(status.hook, false, `${id} hook not registered before install`);
    }
    const dshBefore = before.get("deepseek-harness");
    assert.ok(dshBefore, "DSH is detected via its profile dir");
    assert.equal(dshBefore.mcp, false);
    assert.equal(dshBefore.skill, false);
    assert.equal(dshBefore.rule, undefined, "DSH has no rules surface");
    assert.equal(dshBefore.hook, undefined, "DSH has no host-hook surface");
    assert.ok(dshBefore.paths.mcp.includes(s.cordisPath), "Cordis patch path is reported");

    s.install();
    const after = new Map(
      getAgentRegistrationStatus({ ...s.baseOptions() }).map((status) => [status.id, status])
    );
    for (const id of ALL_HOOK_AGENTS) {
      const status = after.get(id)!;
      assert.equal(status.mcp, true, `${id} MCP registered`);
      // Gemini CLI has no skill directory surface (skill stays false, not undefined).
      if (id !== "gemini") {
        assert.equal(status.skill, true, `${id} skill registered`);
        assert.ok(status.paths.skill.some((p) => p.endsWith("SKILL.md")));
      }
      assert.equal(status.rule, true, `${id} rule registered`);
      assert.equal(status.hook, true, `${id} hook registered`);
    }
    const cursorStatus = after.get("cursor")!;
    assert.ok(cursorStatus.paths.hook?.endsWith("hooks.json"));
    const dshAfter = after.get("deepseek-harness")!;
    assert.equal(dshAfter.mcp, true, "DSH MCP detected from the Cordis patch block");
    assert.equal(dshAfter.skill, true);
    assert.ok(existsSync(s.cordisPath));

    // DSH mcp.json is legacy/inert: status must still say "registered" without it.
    rmSync(s.dshMcpPath, { force: true });
    const afterLegacyRemoved = getAgentRegistrationStatus({ ...s.baseOptions() });
    assert.equal(
      afterLegacyRemoved.find((status) => status.id === "deepseek-harness")?.mcp,
      true,
      "DSH MCP state comes from the Cordis patch, not legacy mcp.json"
    );

    s.uninstall();
    const removedState = new Map(
      getAgentRegistrationStatus({ ...s.baseOptions() }).map((status) => [status.id, status])
    );
    for (const id of ALL_HOOK_AGENTS) {
      const status = removedState.get(id)!;
      assert.equal(status.mcp, false, `${id} MCP unregistered`);
      assert.equal(status.skill, false, `${id} skill unregistered`);
      assert.equal(status.rule, false, `${id} rule unregistered`);
      assert.equal(status.hook, false, `${id} hook unregistered`);
    }
    assert.equal(removedState.get("deepseek-harness")?.mcp, false, "DSH Cordis block removed");

    // Scope: --all includes undetected profiles, --agents restricts to one.
    const allStatuses = getAgentRegistrationStatus({ ...s.baseOptions(), all: true });
    assert.ok(allStatuses.length > removedState.size, "all:true reports every known profile");
    assert.ok(allStatuses.some((status) => status.id === "amazon-q"));
    const scoped = getAgentRegistrationStatus({ ...s.baseOptions(), agentIds: ["cursor"] });
    assert.deepEqual(scoped.map((status) => status.id), ["cursor"]);

    // MCP detection across non-JSON servers-key formats: opencode / zcode / Zed.
    s.install({ agentIds: ["opencode", "zcode", "zed"] });
    const formatStatuses = new Map(
      getAgentRegistrationStatus({ ...s.baseOptions(), all: true }).map((status) => [
        status.id,
        status,
      ])
    );
    for (const id of ["opencode", "zcode", "zed"]) {
      assert.equal(formatStatuses.get(id)!.mcp, true, `${id} MCP registration detected`);
    }
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. CLI status line formatter.
// ---------------------------------------------------------------------------
check("CLI registration status line formatter", () => {
  const base = {
    paths: { mcp: [], skill: [], rule: [], hook: undefined },
  };
  assert.equal(
    formatRegistrationStatusLine({
      ...base,
      id: "cursor",
      name: "Cursor",
      mcp: true,
      skill: true,
      rule: false,
      hook: true,
    }),
    "[MCP ✓] [Skill ✓] [Rule -] [Hook ✓] Cursor (cursor)"
  );
  assert.equal(
    formatRegistrationStatusLine({
      ...base,
      id: "deepseek-harness",
      name: "DeepSeek Harness",
      mcp: false,
      skill: false,
      rule: undefined,
      hook: undefined,
    }),
    "[MCP -] [Skill -] [Rule -] [Hook -] DeepSeek Harness (deepseek-harness)"
  );
});

// ---------------------------------------------------------------------------
// 7. End-to-end `graphflow status` CLI output (isolated env; read-only command).
// ---------------------------------------------------------------------------
check("graphflow status CLI prints per-agent registration lines", () => {
  const s = createSandbox(true);
  try {
    s.install();
    const cliPath = join(__dirname, "..", "src", "cli.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "status"], {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: s.home,
        USERPROFILE: s.home,
        APPDATA: s.appData,
        LOCALAPPDATA: s.localAppData,
        DSH_HOME: s.dshHome,
        KIMI_CODE_HOME: join(s.root, "kimi-home"),
      },
    });
    assert.equal(result.status, 0, `status command failed: ${result.stderr ?? ""}`);
    const output = result.stdout ?? "";
    assert.ok(output.includes("Detected"), "status prints the detected-agents header");
    const lines = output.split(/\r?\n/);
    const registrationLines = lines.filter((line) => line.trimStart().startsWith("[MCP "));
    const cursorLine = registrationLines.find((line) => line.includes("Cursor (cursor)"));
    assert.ok(cursorLine, "status prints a Cursor registration line");
    for (const marker of ["[MCP ✓]", "[Skill ✓]", "[Rule ✓]", "[Hook ✓]"]) {
      assert.ok(cursorLine.includes(marker), `cursor line contains ${marker}`);
    }
    const claudeLine = registrationLines.find((line) => line.includes("Claude Code (claude-code)"));
    assert.ok(claudeLine && claudeLine.includes("[Hook ✓]"), "claude-code hook state printed");
    const dshLine = registrationLines.find((line) => line.includes("DeepSeek Harness (deepseek-harness)"));
    assert.ok(dshLine && dshLine.includes("[MCP ✓]"), "DSH Cordis registration printed as MCP");
    assert.ok(dshLine.includes("[Rule -]") && dshLine.includes("[Hook -]"), "DSH has no rule/hook surface");
  } finally {
    s.cleanup();
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/${checks} installer-hooks check(s) FAILED:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}

console.log(`\nALL ${checks} INSTALLER-HOOKS CHECKS PASSED`);
