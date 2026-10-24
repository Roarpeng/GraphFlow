/**
 * GraphFlow — host hook merge/removal + registration status tests.
 *
 * Covers the "removes everything cleanly" promise:
 *  - installHostHook MERGES into user hook arrays (never overwrites),
 *  - reinstall is idempotent (no duplicate graphflow entries),
 *  - uninstall removes only graphflow-owned hooks and keeps user hooks,
 *  - getAgentRegistrationStatus reports mcp/skill/rule/hook before/after
 *    install and uninstall (including DSH Cordis patch detection),
 *  - JSON configs stay valid throughout,
 *  - the UserPromptSubmit-level "prompt" phase installs for all five hook
 *    hosts (cursor/claude/codex/gemini/zcode), including ZCode's
 *    hooks.enabled + hooks.events.<Event> config-file format,
 *  - the Tier-1 prompt-only hosts (windsurf/trae/qoder/kimi-code/continue):
 *    flat Windsurf entries, Claude-like JSON for the other three, and Kimi
 *    Code's TOML [[hooks]] tables preserved byte-for-byte outside graphflow.
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
import { dirname, join } from "node:path";
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
  zcodeConfig: string;
  windsurfHooks: string;
  traeHooks: string;
  qoderSettings: string;
  kimiConfig: string;
  continueSettings: string;
  baseOptions: () => InstallAllAgentsOptions;
  install: (extra?: Partial<InstallAllAgentsOptions>) => InstallAllAgentsReport;
  uninstall: (extra?: Partial<UninstallAllAgentsOptions>) => AgentInstallItemResult[];
  cleanup: () => void;
}

function createSandbox(includeDsh = false, includeZcode = false, includeNewHosts = false): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "gf-hooks-"));
  const home = join(root, "home");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  const workspace = join(root, "workspace");
  const dshHome = join(root, "dsh-home");
  // Detected-host markers for the four tool-hook agents.
  for (const dir of [home, appData, localAppData, workspace]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const marker of [".cursor", ".claude", ".codex", ".gemini"]) {
    mkdirSync(join(home, marker), { recursive: true });
  }
  if (includeDsh) mkdirSync(dshHome, { recursive: true });
  // ZCode marker + the cli dir its hooks/mcp config.json lives in.
  if (includeZcode) mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
  // Tier-1 prompt-only hook hosts: windsurf / trae / qoder / kimi-code / continue.
  if (includeNewHosts) {
    for (const marker of [join(".codeium", "windsurf"), ".trae", ".qoder", ".kimi-code", ".continue"]) {
      mkdirSync(join(home, marker), { recursive: true });
    }
  }
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
    zcodeConfig: join(home, ".zcode", "cli", "config.json"),
    windsurfHooks: join(home, ".codeium", "windsurf", "hooks.json"),
    traeHooks: join(home, ".trae", "hooks.json"),
    qoderSettings: join(home, ".qoder", "settings.json"),
    kimiConfig: join(home, ".kimi-code", "config.toml"),
    continueSettings: join(home, ".continue", "settings.json"),
    baseOptions,
    install: (extra = {}) => installAllAgents({ ...baseOptions(), ...extra }),
    uninstall: (extra = {}) => uninstallAllAgents({ ...baseOptions(), ...extra }),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const ALL_HOOK_AGENTS = ["cursor", "claude-code", "codex", "gemini"];

/** The five hosts that receive a UserPromptSubmit-level prompt hook (zcode: prompt only). */
const PROMPT_HOOK_AGENTS = [...ALL_HOOK_AGENTS, "zcode"];

/** The Tier-1 hosts that receive a prompt-ONLY hook (no pre/post tool phases). */
const NEW_PROMPT_HOST_AGENTS = ["windsurf", "trae", "qoder", "kimi-code", "continue"];

/**
 * User-owned Kimi config.toml. Ends with exactly one trailing newline so the
 * install+uninstall round trip below can assert byte-for-byte restoration.
 */
const USER_KIMI_TOML = `${[
  "# user-managed kimi settings",
  'model = "k2"',
  "",
  "[[hooks]]",
  'event = "PreToolUse"',
  'matcher = "Bash"',
  'command = "user-kimi-pre"',
  "timeout = 5",
].join("\n")}\n`;

/** The managed Kimi [[hooks]] table GraphFlow must append (timeout in seconds). */
const GRAPHFLOW_KIMI_BLOCK = [
  "[[hooks]]",
  'event = "UserPromptSubmit"',
  'command = "graphflow hook user-prompt"',
  "timeout = 60",
].join("\n");

/**
 * Isolate KIMI_CODE_HOME inside the sandbox: the kimi-code profile's first MCP
 * target follows that env var, and without this an ambient real value would
 * leak writes outside the sandbox.
 */
function withSandboxKimiHome<T>(s: Sandbox, fn: () => T): T {
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = join(s.root, "kimi-home");
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prev;
  }
}

/** Pre-seed user hooks for the five Tier-1 prompt-only hosts. */
function seedTier1UserHooks(s: Sandbox): void {
  // Windsurf: flat { command } entries, snake_case event keys.
  writeJson(s.windsurfHooks, {
    custom: "keep-windsurf",
    hooks: {
      pre_user_prompt: [{ command: "user-windsurf-prompt" }],
      pre_read_code: [{ command: "user-windsurf-read" }],
    },
  });
  // Trae: Claude-like nested entries in ~/.trae/hooks.json.
  writeJson(s.traeHooks, {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-trae-prompt" }] }],
      Stop: [{ hooks: [{ type: "command", command: "user-trae-stop" }] }],
    },
  });
  // Qoder: Claude-like nested entries under the top-level hooks key of settings.json.
  writeJson(s.qoderSettings, {
    qoderSetting: true,
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-qoder-prompt" }] }],
    },
  });
  // Continue: Claude-like nested entries (CLI-only hook surface).
  writeJson(s.continueSettings, {
    theme: "dark",
    hooks: {
      UserPromptSubmit: [
        { matcher: ".*", hooks: [{ type: "command", command: "user-continue-prompt" }] },
      ],
    },
  });
  // Kimi Code: TOML [[hooks]] tables in ~/.kimi-code/config.toml.
  mkdirSync(dirname(s.kimiConfig), { recursive: true });
  writeFileSync(s.kimiConfig, USER_KIMI_TOML, "utf8");
}

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

/**
 * Prompt-phase user entries for the five prompt-hook hosts (run after
 * seedUserHooks). ZCode's config.json deliberately has NO hooks.enabled flag —
 * install must add it — and carries a user MCP server that must survive.
 */
function seedPromptUserHooks(s: Sandbox): void {
  const cursor = readJson(s.cursorHooks);
  cursor.hooks = {
    ...(cursor.hooks as Record<string, unknown>),
    beforeSubmitPrompt: [{ command: "user-cursor-prompt", timeout: 5 }],
  };
  writeJson(s.cursorHooks, cursor);

  const claude = readJson(s.claudeHooks);
  claude.hooks = {
    ...(claude.hooks as Record<string, unknown>),
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-claude-prompt" }] }],
  };
  writeJson(s.claudeHooks, claude);

  const codex = readJson(s.codexHooks);
  codex.hooks = {
    ...(codex.hooks as Record<string, unknown>),
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-codex-prompt" }] }],
  };
  writeJson(s.codexHooks, codex);

  const gemini = readJson(s.geminiHooks);
  gemini.hooks = {
    ...(gemini.hooks as Record<string, unknown>),
    BeforeAgent: [
      {
        matcher: ".*",
        hooks: [{ name: "user-gemini-prompt", type: "command", command: "user-gemini-prompt" }],
      },
    ],
  };
  writeJson(s.geminiHooks, gemini);

  writeJson(s.zcodeConfig, {
    mcp: { servers: { "user-server": { command: "user-mcp", args: [] } } },
    hooks: {
      events: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-zcode-prompt" }] }],
      },
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

// ---------------------------------------------------------------------------
// 8. Prompt (UserPromptSubmit-level) hooks install for all five kinds.
// ---------------------------------------------------------------------------
check("prompt hooks install for all five kinds with the exact per-kind shape", () => {
  const s = createSandbox(false, true);
  try {
    seedUserHooks(s);
    seedPromptUserHooks(s);
    const report = s.install();
    assert.equal(
      report.results.filter((r) => r.category === "hook").length,
      PROMPT_HOOK_AGENTS.length,
      "cursor, claude-code, codex, gemini and zcode each install hooks"
    );

    // ---- Cursor: flat entry under beforeSubmitPrompt, --protocol cursor.
    const cursorHooks = readJson(s.cursorHooks).hooks as Record<string, unknown>;
    assert.deepEqual(cursorHooks.beforeSubmitPrompt, [
      { command: "user-cursor-prompt", timeout: 5 },
      { command: "graphflow hook user-prompt --protocol cursor", timeout: 15 },
    ]);

    // ---- Claude Code: nested entry without matcher, timeout in seconds.
    const claudeHooks = readJson(s.claudeHooks).hooks as Record<string, unknown>;
    assert.deepEqual(claudeHooks.UserPromptSubmit, [
      { hooks: [{ type: "command", command: "user-claude-prompt" }] },
      { hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] },
    ]);

    // ---- Codex: Claude-like nested entry, timeout included (harmless).
    const codexHooks = readJson(s.codexHooks).hooks as Record<string, unknown>;
    assert.deepEqual(codexHooks.UserPromptSubmit, [
      { hooks: [{ type: "command", command: "user-codex-prompt" }] },
      { hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] },
    ]);

    // ---- Gemini: matcher-wrapped named entry under BeforeAgent, timeout ms.
    const geminiHooks = readJson(s.geminiHooks).hooks as Record<string, unknown>;
    assert.deepEqual(geminiHooks.BeforeAgent, [
      {
        matcher: ".*",
        hooks: [{ name: "user-gemini-prompt", type: "command", command: "user-gemini-prompt" }],
      },
      {
        matcher: ".*",
        hooks: [
          {
            name: "graphflow-prompt",
            type: "command",
            command: "graphflow hook user-prompt --protocol gemini",
            timeout: 60000,
          },
        ],
      },
    ]);

    // ---- ZCode: hooks.enabled flag + entries under hooks.events.UserPromptSubmit.
    const zcode = readJson(s.zcodeConfig);
    const zcodeHooks = zcode.hooks as Record<string, unknown>;
    assert.equal(zcodeHooks.enabled, true, "install turns on the ZCode hooks feature flag");
    const zcodeEvents = zcodeHooks.events as Record<string, unknown>;
    assert.deepEqual(Object.keys(zcodeEvents), ["UserPromptSubmit"], "zcode gets ONLY the prompt phase");
    const zcodePrompt = zcodeEvents.UserPromptSubmit as Array<Record<string, unknown>>;
    assert.equal(zcodePrompt.length, 2, "user prompt entry + exactly one graphflow entry");
    assert.ok(hookCommands(zcodePrompt).includes("user-zcode-prompt"));
    assert.deepEqual(zcodePrompt[1], {
      hooks: [{ type: "command", command: "graphflow hook user-prompt", timeoutMs: 60000 }],
    });
    // The MCP registration in the same config file survives the hook write.
    const zcodeServers = (zcode.mcp as Record<string, unknown>).servers as Record<string, unknown>;
    assert.ok(zcodeServers.graphflow, "zcode MCP entry kept alongside the hooks");
    assert.ok(zcodeServers["user-server"], "user MCP server kept alongside the hooks");

    // Tool phases still install alongside for the four tool-hook hosts.
    assert.equal(countGraphflowCommands(cursorHooks.preToolUse), 1);
    assert.equal(countGraphflowCommands(cursorHooks.postToolUse), 1);
    assert.equal(countGraphflowCommands(claudeHooks.PreToolUse), 1);
    assert.equal(countGraphflowCommands(claudeHooks.PostToolUse), 1);
    assert.equal(countGraphflowCommands(codexHooks.PreToolUse), 1);
    assert.equal(countGraphflowCommands(codexHooks.PostToolUse), 1);
    assert.equal(countGraphflowCommands(geminiHooks.BeforeTool), 1);
    assert.equal(countGraphflowCommands(geminiHooks.AfterTool), 1);

    // Registration status sees the zcode hook (hasGraphflowHook, prompt-only kind).
    const statuses = new Map(
      getAgentRegistrationStatus({ ...s.baseOptions() }).map((status) => [status.id, status])
    );
    assert.equal(statuses.get("zcode")?.hook, true, "zcode hook registration detected");
    assert.ok(statuses.get("zcode")?.paths.hook?.endsWith(join(".zcode", "cli", "config.json")));
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Prompt-hook reinstall is idempotent.
// ---------------------------------------------------------------------------
check("prompt-hook reinstall is idempotent (no duplicate entries)", () => {
  const s = createSandbox(false, true);
  try {
    seedUserHooks(s);
    seedPromptUserHooks(s);
    s.install();
    const snapshot = {
      cursor: readFileSync(s.cursorHooks, "utf8"),
      claude: readFileSync(s.claudeHooks, "utf8"),
      codex: readFileSync(s.codexHooks, "utf8"),
      gemini: readFileSync(s.geminiHooks, "utf8"),
      zcode: readFileSync(s.zcodeConfig, "utf8"),
    };
    s.install();

    assert.equal(readFileSync(s.cursorHooks, "utf8"), snapshot.cursor, "cursor byte-identical on reinstall");
    assert.equal(readFileSync(s.claudeHooks, "utf8"), snapshot.claude, "claude byte-identical on reinstall");
    assert.equal(readFileSync(s.codexHooks, "utf8"), snapshot.codex, "codex byte-identical on reinstall");
    assert.equal(readFileSync(s.geminiHooks, "utf8"), snapshot.gemini, "gemini byte-identical on reinstall");
    assert.equal(readFileSync(s.zcodeConfig, "utf8"), snapshot.zcode, "zcode config byte-identical on reinstall");

    const cursorHooks = readJson(s.cursorHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(cursorHooks.beforeSubmitPrompt), 1);
    const claudeHooks = readJson(s.claudeHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(claudeHooks.UserPromptSubmit), 1);
    const codexHooks = readJson(s.codexHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(codexHooks.UserPromptSubmit), 1);
    const geminiHooks = readJson(s.geminiHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(geminiHooks.BeforeAgent), 1);
    const zcodeEvents = (readJson(s.zcodeConfig).hooks as Record<string, unknown>).events as Record<
      string,
      unknown
    >;
    assert.equal(countGraphflowCommands(zcodeEvents.UserPromptSubmit), 1);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 10. Uninstall removes prompt entries but preserves user prompt entries.
// ---------------------------------------------------------------------------
check("uninstall removes graphflow prompt hooks but keeps user prompt hooks", () => {
  const s = createSandbox(false, true);
  try {
    seedUserHooks(s);
    seedPromptUserHooks(s);
    s.install();
    const removed = s.uninstall({ agentIds: PROMPT_HOOK_AGENTS });
    assert.equal(
      removed.filter((r) => r.category === "hook" && r.status === "removed").length,
      PROMPT_HOOK_AGENTS.length,
      "hook removal reported for every prompt-hook host"
    );
    for (const hookPath of [s.cursorHooks, s.claudeHooks, s.codexHooks, s.geminiHooks, s.zcodeConfig]) {
      JSON.parse(readFileSync(hookPath, "utf8")); // still valid JSON
    }

    const cursorHooks = readJson(s.cursorHooks).hooks as Record<string, unknown>;
    assert.deepEqual(
      (cursorHooks.beforeSubmitPrompt as Array<Record<string, unknown>>).map((h) => h.command),
      ["user-cursor-prompt"]
    );
    const claudeHooks = readJson(s.claudeHooks).hooks as Record<string, unknown>;
    assert.deepEqual(hookCommands(claudeHooks.UserPromptSubmit), ["user-claude-prompt"]);
    const codexHooks = readJson(s.codexHooks).hooks as Record<string, unknown>;
    assert.deepEqual(hookCommands(codexHooks.UserPromptSubmit), ["user-codex-prompt"]);
    const geminiHooks = readJson(s.geminiHooks).hooks as Record<string, unknown>;
    assert.deepEqual(hookCommands(geminiHooks.BeforeAgent), ["user-gemini-prompt"]);

    const zcode = readJson(s.zcodeConfig);
    const zcodeHooks = zcode.hooks as Record<string, unknown>;
    const zcodeEvents = zcodeHooks.events as Record<string, unknown>;
    assert.deepEqual(hookCommands(zcodeEvents.UserPromptSubmit), ["user-zcode-prompt"]);
    assert.equal(zcodeHooks.enabled, true, "zcode hooks.enabled is left in place (harmless)");
    const zcodeServers = (zcode.mcp as Record<string, unknown>).servers as Record<string, unknown>;
    assert.ok(zcodeServers["user-server"], "user MCP server survives zcode uninstall");
    assert.ok(!("graphflow" in zcodeServers), "graphflow MCP server removed from zcode config");

    // Second uninstall: nothing graphflow-owned left to remove.
    const second = s.uninstall({ agentIds: PROMPT_HOOK_AGENTS });
    assert.equal(second.filter((r) => r.category === "hook").length, 0);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. ZCode-specific removal edge cases (events-wrapped sanitizer).
// ---------------------------------------------------------------------------
check("zcode hook removal drops an emptied events key, keeps the enabled flag and other events", () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-zcode-hook-"));
  try {
    const configPath = join(dir, "config.json");
    writeJson(configPath, {
      hooks: {
        enabled: true,
        events: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "graphflow hook user-prompt" }] },
          ],
          SessionStart: [{ hooks: [{ type: "command", command: "user-session" }] }],
        },
      },
    });
    assert.equal(removeHostHook("zcode", configPath), true);
    const hooks = readJson(configPath).hooks as Record<string, unknown>;
    assert.equal(hooks.enabled, true, "enabled flag untouched");
    const events = hooks.events as Record<string, unknown>;
    assert.ok(!("UserPromptSubmit" in events), "emptied prompt event key removed");
    assert.deepEqual(hookCommands(events.SessionStart), ["user-session"], "unrelated zcode event survives");
    assert.equal(removeHostHook("zcode", configPath), false, "second removal is a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. Tier-1 prompt-only hosts: windsurf / trae / qoder / kimi-code / continue.
// ---------------------------------------------------------------------------
check("prompt hooks install for windsurf/trae/qoder/kimi-code/continue with the exact per-host shape", () => {
  const s = createSandbox(false, false, true);
  try {
    seedTier1UserHooks(s);
    const report = withSandboxKimiHome(s, () => s.install({ agentIds: NEW_PROMPT_HOST_AGENTS }));
    assert.equal(
      report.results.filter((r) => r.category === "hook").length,
      NEW_PROMPT_HOST_AGENTS.length,
      "windsurf, trae, qoder, kimi-code and continue each install one hook entry"
    );

    // ---- Windsurf (~/.codeium/windsurf/hooks.json): flat { command } entries
    //      under pre_user_prompt; the documented schema has no timeout field.
    const windsurf = readJson(s.windsurfHooks);
    const windsurfHooks = windsurf.hooks as Record<string, unknown>;
    assert.deepEqual(windsurfHooks.pre_user_prompt, [
      { command: "user-windsurf-prompt" },
      { command: "graphflow hook user-prompt" },
    ]);
    assert.deepEqual(
      windsurfHooks.pre_read_code,
      [{ command: "user-windsurf-read" }],
      "unrelated windsurf event preserved"
    );
    assert.equal(windsurf.custom, "keep-windsurf", "unrelated windsurf top-level key preserved");

    // ---- Trae (~/.trae/hooks.json): Claude-like nested entry, timeout in seconds.
    const traeHooks = readJson(s.traeHooks).hooks as Record<string, unknown>;
    assert.deepEqual(traeHooks.UserPromptSubmit, [
      { hooks: [{ type: "command", command: "user-trae-prompt" }] },
      { hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] },
    ]);
    assert.deepEqual(hookCommands(traeHooks.Stop), ["user-trae-stop"], "unrelated trae event preserved");

    // ---- Qoder (~/.qoder/settings.json): Claude-like nested entry under hooks.
    const qoder = readJson(s.qoderSettings);
    const qoderHooks = qoder.hooks as Record<string, unknown>;
    assert.deepEqual(qoderHooks.UserPromptSubmit, [
      { hooks: [{ type: "command", command: "user-qoder-prompt" }] },
      { hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] },
    ]);
    assert.equal(qoder.qoderSetting, true, "unrelated qoder settings key preserved");

    // ---- Continue (~/.continue/settings.json): Claude-like nested entry (CLI-only surface).
    const cont = readJson(s.continueSettings);
    const contHooks = cont.hooks as Record<string, unknown>;
    assert.deepEqual(contHooks.UserPromptSubmit, [
      { matcher: ".*", hooks: [{ type: "command", command: "user-continue-prompt" }] },
      { hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] },
    ]);
    assert.equal(cont.theme, "dark", "unrelated continue settings key preserved");

    // ---- Kimi Code (~/.kimi-code/config.toml): managed [[hooks]] table
    //      appended, user TOML preserved verbatim ahead of it.
    const kimi = readFileSync(s.kimiConfig, "utf8");
    assert.ok(kimi.startsWith(USER_KIMI_TOML.trimEnd()), "user TOML content preserved verbatim");
    assert.ok(kimi.endsWith(`${GRAPHFLOW_KIMI_BLOCK}\n`), "managed [[hooks]] table appended at EOF");
    assert.equal(
      kimi.split("[[hooks]]").length - 1,
      2,
      "exactly the user table + the graphflow table"
    );

    // Registration status detects the prompt hooks for every new kind.
    const statuses = withSandboxKimiHome(s, () =>
      new Map(getAgentRegistrationStatus({ ...s.baseOptions() }).map((st) => [st.id, st]))
    );
    for (const id of NEW_PROMPT_HOST_AGENTS) {
      assert.equal(statuses.get(id)?.hook, true, `${id} hook registration detected`);
    }
    assert.ok(
      statuses.get("windsurf")?.paths.hook?.endsWith(join(".codeium", "windsurf", "hooks.json"))
    );
    assert.ok(statuses.get("qoder")?.paths.hook?.endsWith(join(".qoder", "settings.json")));
    assert.ok(statuses.get("kimi-code")?.paths.hook?.endsWith(join(".kimi-code", "config.toml")));
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 13. Tier-1 prompt-hook reinstall is idempotent (incl. the Kimi TOML file).
// ---------------------------------------------------------------------------
check("tier-1 prompt-hook reinstall is idempotent (no duplicate entries, TOML untouched)", () => {
  const s = createSandbox(false, false, true);
  try {
    seedTier1UserHooks(s);
    withSandboxKimiHome(s, () => s.install({ agentIds: NEW_PROMPT_HOST_AGENTS }));
    const snapshot = {
      windsurf: readFileSync(s.windsurfHooks, "utf8"),
      trae: readFileSync(s.traeHooks, "utf8"),
      qoder: readFileSync(s.qoderSettings, "utf8"),
      kimi: readFileSync(s.kimiConfig, "utf8"),
      continue: readFileSync(s.continueSettings, "utf8"),
    };
    withSandboxKimiHome(s, () => s.install({ agentIds: NEW_PROMPT_HOST_AGENTS }));

    assert.equal(readFileSync(s.windsurfHooks, "utf8"), snapshot.windsurf, "windsurf byte-identical on reinstall");
    assert.equal(readFileSync(s.traeHooks, "utf8"), snapshot.trae, "trae byte-identical on reinstall");
    assert.equal(readFileSync(s.qoderSettings, "utf8"), snapshot.qoder, "qoder byte-identical on reinstall");
    assert.equal(readFileSync(s.kimiConfig, "utf8"), snapshot.kimi, "kimi config.toml byte-identical on reinstall");
    assert.equal(readFileSync(s.continueSettings, "utf8"), snapshot.continue, "continue byte-identical on reinstall");

    const windsurfHooks = readJson(s.windsurfHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(windsurfHooks.pre_user_prompt), 1);
    const traeHooks = readJson(s.traeHooks).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(traeHooks.UserPromptSubmit), 1);
    const qoderHooks = readJson(s.qoderSettings).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(qoderHooks.UserPromptSubmit), 1);
    const contHooks = readJson(s.continueSettings).hooks as Record<string, unknown>;
    assert.equal(countGraphflowCommands(contHooks.UserPromptSubmit), 1);
    assert.equal(
      (readFileSync(s.kimiConfig, "utf8").match(/graphflow hook user-prompt/g) ?? []).length,
      1,
      "exactly one graphflow [[hooks]] table in kimi config.toml"
    );
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 14. Tier-1 uninstall: graphflow entries removed, user entries kept; the
//     pre-existing non-graphflow Kimi [[hooks]] block survives byte-for-byte.
// ---------------------------------------------------------------------------
check("tier-1 uninstall removes graphflow prompt hooks; kimi user [[hooks]] survives byte-for-byte", () => {
  const s = createSandbox(false, false, true);
  try {
    seedTier1UserHooks(s);
    withSandboxKimiHome(s, () => s.install({ agentIds: NEW_PROMPT_HOST_AGENTS }));
    const removed = withSandboxKimiHome(s, () => s.uninstall({ agentIds: NEW_PROMPT_HOST_AGENTS }));
    assert.equal(
      removed.filter((r) => r.category === "hook" && r.status === "removed").length,
      NEW_PROMPT_HOST_AGENTS.length,
      "hook removal reported for every tier-1 host"
    );
    for (const hookPath of [s.windsurfHooks, s.traeHooks, s.qoderSettings, s.continueSettings]) {
      JSON.parse(readFileSync(hookPath, "utf8")); // still valid JSON
    }

    const windsurfHooks = readJson(s.windsurfHooks).hooks as Record<string, unknown>;
    assert.deepEqual(windsurfHooks.pre_user_prompt, [{ command: "user-windsurf-prompt" }]);
    assert.deepEqual(windsurfHooks.pre_read_code, [{ command: "user-windsurf-read" }]);

    const traeHooks = readJson(s.traeHooks).hooks as Record<string, unknown>;
    assert.deepEqual(hookCommands(traeHooks.UserPromptSubmit), ["user-trae-prompt"]);
    assert.deepEqual(hookCommands(traeHooks.Stop), ["user-trae-stop"]);

    const qoder = readJson(s.qoderSettings);
    assert.deepEqual(hookCommands((qoder.hooks as Record<string, unknown>).UserPromptSubmit), [
      "user-qoder-prompt",
    ]);
    assert.equal(qoder.qoderSetting, true);

    const contHooks = readJson(s.continueSettings).hooks as Record<string, unknown>;
    assert.deepEqual(hookCommands(contHooks.UserPromptSubmit), ["user-continue-prompt"]);

    // Kimi: install+uninstall restores the user config.toml byte-for-byte,
    // including the pre-existing non-graphflow [[hooks]] block.
    assert.equal(
      readFileSync(s.kimiConfig, "utf8"),
      USER_KIMI_TOML,
      "kimi config.toml restored byte-for-byte (user [[hooks]] block intact)"
    );

    const statuses = withSandboxKimiHome(s, () =>
      new Map(getAgentRegistrationStatus({ ...s.baseOptions() }).map((st) => [st.id, st]))
    );
    for (const id of NEW_PROMPT_HOST_AGENTS) {
      assert.equal(statuses.get(id)?.hook, false, `${id} hook unregistered`);
    }

    const second = withSandboxKimiHome(s, () => s.uninstall({ agentIds: NEW_PROMPT_HOST_AGENTS }));
    assert.equal(second.filter((r) => r.category === "hook").length, 0, "second uninstall is a no-op");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tier-2 prompt-reflex plugin assets: OpenCode / Kilo shared plugin, Cline
// file hook (Unix-only), DSH Cordis plugin + managed patch block.
// ---------------------------------------------------------------------------

check("Tier-2 reflex assets: OpenCode/Kilo plugins, Cline file hook, DSH plugin + patch row", () => {
  const s = createSandbox(true, false, false);
  // Tier-2 host markers: opencode (~/.config/opencode), kilocode (~/.kilocode),
  // cline (portable home/.config Code globalStorage marker).
  mkdirSync(join(s.home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(s.home, ".kilocode"), { recursive: true });
  mkdirSync(
    join(s.home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
    { recursive: true }
  );
  try {
    const report = s.install();
    const hookResults = report.results.filter((r) => r.category === "hook");

    const ocPlugin = join(s.home, ".config", "opencode", "plugin", "graphflow-prompt-reflex.ts");
    const kiloPlugin = join(s.home, ".config", "kilo", "plugin", "graphflow-prompt-reflex.ts");
    const clineHook = join(s.home, "Documents", "Cline", "Hooks", "UserPromptSubmit");
    const dshPlugin = join(s.dshHome, "plugins", "graphflow-prompt-reflex.mjs");

    assert.ok(existsSync(ocPlugin), "OpenCode plugin written");
    assert.ok(
      readFileSync(ocPlugin, "utf8").includes('"chat.message"') &&
        readFileSync(ocPlugin, "utf8").includes("graphflow hook user-prompt"),
      "OpenCode plugin carries the chat.message reflex wiring"
    );
    assert.ok(existsSync(kiloPlugin), "Kilo plugin written");
    assert.equal(readFileSync(ocPlugin, "utf8"), readFileSync(kiloPlugin, "utf8"), "shared plugin is byte-identical on both hosts");

    const clineResult = hookResults.find((r) => r.targetPath === clineHook);
    if (process.platform === "win32") {
      assert.equal(clineResult?.status, "skipped", "Cline hook skipped on win32");
      assert.ok(!existsSync(clineHook), "no Cline hook file on win32");
    } else {
      assert.equal(clineResult?.status, "installed", "Cline hook installed");
      assert.ok(
        readFileSync(clineHook, "utf8").startsWith("#!/usr/bin/env node"),
        "Cline hook has the node shebang"
      );
    }

    assert.ok(existsSync(dshPlugin), "DSH reflex plugin written");
    const patch = readFileSync(s.cordisPath, "utf8");
    assert.ok(patch.includes("# GRAPHFLOW-DSH-BEGIN"), "MCP managed block still present");
    assert.ok(patch.includes("# GRAPHFLOW-DSH-HOOK-BEGIN"), "reflex managed block present");
    assert.ok(
      patch.indexOf("# GRAPHFLOW-DSH-BEGIN") < patch.indexOf("# GRAPHFLOW-DSH-HOOK-BEGIN"),
      "MCP block precedes the reflex block"
    );
    assert.ok(
      patch.includes("name: './plugins/graphflow-prompt-reflex.mjs'"),
      "patch row anchors the plugin beside the patch file"
    );

    // Idempotency: reinstall leaves every asset byte-identical.
    const ocBefore = readFileSync(ocPlugin, "utf8");
    const patchBefore = patch;
    s.install();
    assert.equal(readFileSync(ocPlugin, "utf8"), ocBefore, "plugin byte-identical after reinstall");
    assert.equal(readFileSync(s.cordisPath, "utf8"), patchBefore, "patch byte-identical after reinstall");

    // A user-authored plugin in the same dir must survive uninstall.
    const userPlugin = join(s.home, ".config", "opencode", "plugin", "my-own.ts");
    writeFileSync(userPlugin, "export default { id: 'mine', server: async () => ({}) };\n", "utf8");

    s.uninstall();
    assert.ok(!existsSync(ocPlugin), "graphflow plugin removed");
    assert.ok(!existsSync(kiloPlugin), "kilo plugin removed");
    assert.ok(existsSync(userPlugin), "user plugin untouched");
    if (process.platform !== "win32") {
      assert.ok(!existsSync(clineHook), "cline hook removed");
    }
    assert.ok(!existsSync(dshPlugin), "dsh plugin removed");
    const patchAfter = readFileSync(s.cordisPath, "utf8");
    assert.ok(!patchAfter.includes("# GRAPHFLOW-DSH-HOOK-BEGIN"), "reflex block removed from patch");
    // Full uninstall removes ALL graphflow registrations — the MCP managed
    // block is graphflow-owned too, so it is gone as well.
    assert.ok(!patchAfter.includes("# GRAPHFLOW-DSH-BEGIN"), "MCP managed block removed by full uninstall");
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
