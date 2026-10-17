/**
 * GraphFlow — DeepSeek Harness (DSH) Cordis patch installer tests.
 *
 * DSH does not read `~/.dsh/mcp.json`; it loads MCP servers from Cordis inserts
 * in `~/.dsh/cordis.patch.yml`. These tests verify the managed marker block is
 * written idempotently (with a pinned workspace `cwd`), replaces the old
 * `!!js process.cwd()` block, is removed cleanly on uninstall, and that
 * uninstall scoping never wipes profiles the caller did not ask for.
 *
 * Every sandbox (home / AppData / LocalAppData / workspace / DSH_HOME) is a
 * fresh mkdtemp directory passed through installer options, so the real
 * `~/.dsh` and real HOME are never touched.
 *
 * Standalone: `npx tsx tests/installer-dsh.test.ts`
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAPHFLOW_DSH_BEGIN,
  GRAPHFLOW_DSH_END,
  type AgentInstallItemResult,
  type InstallAllAgentsOptions,
  type InstallAllAgentsReport,
  type UninstallAllAgentsOptions,
  installAllAgents,
  uninstallAllAgents,
} from "../src/agent-installer.js";

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

function occurrenceCount(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function forwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

interface Sandbox {
  root: string;
  home: string;
  appData: string;
  localAppData: string;
  workspace: string;
  dshHome: string;
  cordisPath: string;
  mcpPath: string;
  skillPath: string;
  baseOptions: () => InstallAllAgentsOptions;
  options: (extra?: Partial<UninstallAllAgentsOptions>) => InstallAllAgentsOptions;
  install: (extra?: Partial<InstallAllAgentsOptions>) => InstallAllAgentsReport;
  uninstall: (extra?: Partial<UninstallAllAgentsOptions>) => AgentInstallItemResult[];
  cleanup: () => void;
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "gf-dsh-installer-"));
  const home = join(root, "home");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  const workspace = join(root, "workspace");
  const dshHome = join(root, "dsh-home");
  for (const dir of [home, appData, localAppData, workspace, dshHome]) {
    mkdirSync(dir, { recursive: true });
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
    mcpPath: join(dshHome, "mcp.json"),
    skillPath: join(dshHome, "skills", "graphflow", "SKILL.md"),
    baseOptions,
    options: (extra = {}) => ({ ...baseOptions(), ...extra }),
    install: (extra = {}) => installAllAgents({ ...baseOptions(), ...extra }),
    uninstall: (extra = {}) => uninstallAllAgents({ ...baseOptions(), ...extra }),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const OLD_DSH_BLOCK = [
  GRAPHFLOW_DSH_BEGIN,
  "- insert:",
  "    - id: mcp-graphflow",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: graphflow",
  "        transport: stdio",
  "        command: npx",
  "        args: ['-y','--package=@roarpeng/graphflow','graphflow-mcp']",
  "        cwd: !!js process.cwd()",
  "        env: { GRAPHFLOW_MCP_STDIO: '1', GRAPHFLOW_LOG_JSON: '1' }",
  "        failOnStartupError: false",
  GRAPHFLOW_DSH_END,
].join("\n");

// ---------------------------------------------------------------------------
// 1. Install writes the managed Cordis insert, plus legacy mcp.json and skill.
// ---------------------------------------------------------------------------
check("install writes DSH Cordis patch with pinned cwd/env, mcp.json and skill", () => {
  const s = createSandbox();
  try {
    const report = s.install();
    const expectedWorkspace = forwardSlashes(s.workspace);

    assert.ok(existsSync(s.cordisPath), "cordis.patch.yml must be created");
    const patch = readFileSync(s.cordisPath, "utf8");

    assert.equal(occurrenceCount(patch, GRAPHFLOW_DSH_BEGIN), 1, "exactly one begin marker");
    assert.equal(occurrenceCount(patch, GRAPHFLOW_DSH_END), 1, "exactly one end marker");
    assert.ok(patch.includes("- insert:"), "Cordis insert payload present");
    assert.ok(patch.includes("id: mcp-graphflow"), "server id present");
    assert.ok(patch.includes("name: '@deepseek-ai/dsh-mcp-client'"), "DSH MCP client plugin named");
    assert.ok(patch.includes("serverName: graphflow"), "serverName present");
    assert.ok(patch.includes("transport: stdio"), "stdio transport present");
    assert.ok(patch.includes("command: npx"), "npx launcher present");
    assert.ok(patch.includes("graphflow-mcp"), "graphflow-mcp entrypoint present");
    assert.ok(
      patch.includes(`cwd: "${expectedWorkspace}"`),
      `cwd must be the YAML-quoted, forward-slash workspace (${expectedWorkspace})`
    );
    assert.ok(
      patch.includes(`GRAPHFLOW_WORKSPACE_ROOT: "${expectedWorkspace}"`),
      "GRAPHFLOW_WORKSPACE_ROOT env must point at the workspace"
    );
    assert.ok(patch.includes("GRAPHFLOW_MCP_STDIO: '1'"), "legacy MCP_STDIO env preserved");
    assert.ok(patch.includes("GRAPHFLOW_LOG_JSON: '1'"), "legacy LOG_JSON env preserved");
    assert.ok(patch.includes("failOnStartupError: false"), "startup failure policy preserved");
    assert.ok(!patch.includes("!!js"), "no legacy !!js tag emitted");
    assert.ok(!patch.includes("process.cwd()"), "no legacy process.cwd() emitted");

    // Legacy mcp.json copy + skill are still written for backwards compat.
    const mcp = JSON.parse(readFileSync(s.mcpPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.ok(mcp.mcpServers?.graphflow, "legacy mcp.json graphflow entry kept");
    const skill = readFileSync(s.skillPath, "utf8");
    assert.ok(skill.includes("name: graphflow"), "skill SKILL.md written");

    const cordisResult = report.results.find(
      (r) => r.agentId === "deepseek-harness" && r.category === "mcp" && r.targetPath === s.cordisPath
    );
    assert.ok(cordisResult, "install report must include the Cordis target as mcp");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Reinstall is idempotent (byte-identical, markers not duplicated).
// ---------------------------------------------------------------------------
check("reinstall is idempotent and does not duplicate the marker block", () => {
  const s = createSandbox();
  try {
    s.install();
    const first = readFileSync(s.cordisPath, "utf8");
    const secondReport = s.install();
    const second = readFileSync(s.cordisPath, "utf8");

    assert.equal(second, first, "reinstall must leave cordis.patch.yml byte-identical");
    assert.equal(occurrenceCount(second, GRAPHFLOW_DSH_BEGIN), 1);
    assert.equal(occurrenceCount(second, GRAPHFLOW_DSH_END), 1);
    assert.ok(
      secondReport.results.some(
        (r) => r.category === "mcp" && r.targetPath === s.cordisPath && r.status === "updated"
      ),
      "reinstall reports the Cordis target as updated"
    );
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Old marker block (!!js process.cwd()) is replaced; user patches survive.
// ---------------------------------------------------------------------------
check("install replaces the legacy !!js process.cwd() block in place and keeps user patches", () => {
  const s = createSandbox();
  try {
    const userHead = [
      "# user patch head",
      "- insert:",
      "    - id: user-plugin",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config: { serverName: user }",
    ].join("\n");
    const userTail = "# user patch tail";
    writeFileSync(s.cordisPath, `${userHead}\n\n${OLD_DSH_BLOCK}\n\n${userTail}\n`, "utf8");

    s.install();
    const patch = readFileSync(s.cordisPath, "utf8");
    const expectedWorkspace = forwardSlashes(s.workspace);

    assert.ok(!patch.includes("!!js"), "legacy !!js tag must be gone");
    assert.ok(!patch.includes("process.cwd()"), "legacy process.cwd() must be gone");
    assert.ok(patch.includes(`cwd: "${expectedWorkspace}"`), "new pinned cwd must be present");
    assert.equal(occurrenceCount(patch, GRAPHFLOW_DSH_BEGIN), 1, "no duplicated begin marker");
    assert.equal(occurrenceCount(patch, GRAPHFLOW_DSH_END), 1, "no duplicated end marker");
    assert.ok(patch.includes("user-plugin"), "unrelated Cordis insert before the block preserved");
    assert.ok(patch.includes("# user patch head"), "leading user patch comment preserved");
    assert.ok(patch.includes("# user patch tail"), "trailing user patch comment preserved");

    // Idempotent after the replacement too.
    s.install();
    assert.equal(readFileSync(s.cordisPath, "utf8"), patch, "replacement must be stable");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Empty file and `[]` placeholders become the block (no second YAML root).
// ---------------------------------------------------------------------------
check("install handles an empty file, an exact `[]`, and a missing workspaceRoot", () => {
  const empty = createSandbox();
  try {
    writeFileSync(empty.cordisPath, "", "utf8");
    empty.install();
    const patch = readFileSync(empty.cordisPath, "utf8");
    assert.ok(patch.startsWith(GRAPHFLOW_DSH_BEGIN), "empty file becomes the managed block");
    assert.equal(occurrenceCount(patch, GRAPHFLOW_DSH_BEGIN), 1);
    assert.ok(patch.includes(`cwd: "${forwardSlashes(empty.workspace)}"`));
  } finally {
    empty.cleanup();
  }

  const flowSeq = createSandbox();
  try {
    writeFileSync(flowSeq.cordisPath, "[]\n", "utf8");
    flowSeq.install();
    const patch = readFileSync(flowSeq.cordisPath, "utf8");
    assert.ok(!/^\s*\[\s*\]\s*$/m.test(patch), "`[]` placeholder must be replaced, not kept");
    assert.ok(patch.startsWith(GRAPHFLOW_DSH_BEGIN));
    assert.equal(occurrenceCount(patch, GRAPHFLOW_DSH_BEGIN), 1);
    assert.ok(patch.includes(`cwd: "${forwardSlashes(flowSeq.workspace)}"`));
  } finally {
    flowSeq.cleanup();
  }

  const defaultCwd = createSandbox();
  try {
    const { workspaceRoot: _ignored, ...withoutWorkspace } = defaultCwd.baseOptions();
    installAllAgents(withoutWorkspace);
    const patch = readFileSync(defaultCwd.cordisPath, "utf8");
    assert.ok(
      patch.includes(`cwd: "${forwardSlashes(process.cwd())}"`),
      "cwd falls back to process.cwd() when workspaceRoot is not given"
    );
  } finally {
    defaultCwd.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Uninstall removes the block, legacy mcp.json entry and skill, cleanly.
// ---------------------------------------------------------------------------
check("uninstall removes the Cordis block (empty patch array), mcp.json entry and skill", () => {
  const s = createSandbox();
  try {
    s.install();
    assert.ok(existsSync(s.cordisPath));

    const removed = s.uninstall({ agentIds: ["deepseek-harness"] });

    assert.ok(existsSync(s.cordisPath), "patch file is kept, only the managed block is removed");
    assert.equal(
      readFileSync(s.cordisPath, "utf8").trim(),
      "[]",
      "file becomes an empty YAML patch array when only the block existed"
    );
    assert.ok(
      removed.some((r) => r.category === "mcp" && r.targetPath === s.cordisPath && r.status === "removed"),
      "removal reported for the Cordis patch"
    );
    assert.ok(
      removed.some((r) => r.category === "mcp" && r.targetPath === s.mcpPath && r.status === "removed"),
      "removal reported for legacy mcp.json"
    );
    assert.ok(
      removed.some((r) => r.category === "skill" && r.targetPath.endsWith("SKILL.md")),
      "removal reported for the skill"
    );

    const mcp = JSON.parse(readFileSync(s.mcpPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.ok(!mcp.mcpServers || !("graphflow" in mcp.mcpServers), "legacy mcp.json entry removed");
    assert.ok(!existsSync(join(s.dshHome, "skills", "graphflow")), "skill dir removed");
    assert.ok(!readFileSync(s.cordisPath, "utf8").includes(GRAPHFLOW_DSH_BEGIN), "begin marker gone");
    assert.ok(!readFileSync(s.cordisPath, "utf8").includes(GRAPHFLOW_DSH_END), "end marker gone");
  } finally {
    s.cleanup();
  }
});

check("uninstall keeps unrelated Cordis patches and leaves valid YAML", () => {
  const s = createSandbox();
  try {
    s.install();
    const userYaml = [
      "# user patch head",
      "- insert:",
      "    - id: user-kept",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config: { serverName: user }",
    ].join("\n");
    writeFileSync(s.cordisPath, `${userYaml}\n\n${readFileSync(s.cordisPath, "utf8")}`, "utf8");

    s.uninstall({ agentIds: ["deepseek-harness"] });
    const after = readFileSync(s.cordisPath, "utf8");

    assert.ok(!after.includes(GRAPHFLOW_DSH_BEGIN), "graphflow begin marker removed");
    assert.ok(!after.includes(GRAPHFLOW_DSH_END), "graphflow end marker removed");
    assert.ok(after.includes("user-kept"), "unrelated insert preserved");
    assert.ok(after.includes("# user patch head"), "unrelated comment preserved");
    assert.ok(after.trim().startsWith("# user patch head"), "remaining YAML still starts with the user patch");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Agent scoping: --agents touches only the selected profile; --all everything.
// ---------------------------------------------------------------------------
check("uninstall({agentIds}) does not touch other installed profiles; {all} does", () => {
  const s = createSandbox();
  try {
    s.install({ agentIds: ["deepseek-harness"] });

    // A detected Cursor profile with a graphflow entry and a third-party entry.
    mkdirSync(join(s.home, ".cursor"), { recursive: true });
    const cursorPath = join(s.home, ".cursor", "mcp.json");
    const cursorConfig = {
      mcpServers: {
        graphflow: { command: "node", args: ["C:/old/graphflow/dist/mcp-server.js"] },
        other: { command: "other-cmd", args: [] },
      },
    };
    writeFileSync(cursorPath, `${JSON.stringify(cursorConfig, null, 2)}\n`, "utf8");
    const cursorBefore = readFileSync(cursorPath, "utf8");

    const scoped = s.uninstall({ agentIds: ["deepseek-harness"] });
    assert.ok(
      scoped.every((r) => r.agentId === "deepseek-harness"),
      "scoped uninstall only reports the selected agent"
    );
    assert.equal(
      readFileSync(cursorPath, "utf8"),
      cursorBefore,
      "Cursor mcp.json must be untouched when uninstalling DSH only"
    );
    assert.ok(!readFileSync(s.cordisPath, "utf8").includes(GRAPHFLOW_DSH_BEGIN), "DSH block removed");

    // Explicit --all removes every profile's graphflow registrations.
    s.uninstall({ all: true });
    const cursorAfter = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    assert.ok(!("graphflow" in cursorAfter.mcpServers), "graphflow entry removed with all:true");
    assert.ok("other" in cursorAfter.mcpServers, "third-party Cursor entry preserved");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. Default uninstall (no flags) only touches detected profiles.
// ---------------------------------------------------------------------------
check("uninstall() default removes detected agents only and leaves undetected leftovers", () => {
  const s = createSandbox();
  try {
    // DSH is detected because its profile dir exists.
    s.install();

    // A stale graphflow skill in a marker-free shared skills dir (Codex's
    // ~/.agents/skills) must survive a default uninstall because Codex itself
    // is not detected, and be removed by the explicit --all path.
    const staleSkillDir = join(s.home, ".agents", "skills", "graphflow");
    mkdirSync(staleSkillDir, { recursive: true });
    writeFileSync(join(staleSkillDir, "SKILL.md"), "stale codex skill\n", "utf8");

    const removed = s.uninstall();
    assert.ok(removed.length > 0, "default uninstall removes the detected DSH profile");
    assert.ok(
      removed.every((r) => r.agentId === "deepseek-harness"),
      "default uninstall only reports detected agents"
    );
    assert.ok(!readFileSync(s.cordisPath, "utf8").includes(GRAPHFLOW_DSH_BEGIN), "detected DSH block removed");
    assert.ok(
      existsSync(join(staleSkillDir, "SKILL.md")),
      "undetected profile leftovers must survive the default uninstall"
    );

    s.uninstall({ all: true });
    assert.ok(!existsSync(staleSkillDir), "explicit all:true clears undetected leftovers");

    // Nothing left to remove -> empty report, no throw.
    assert.deepEqual(s.uninstall(), [], "repeated default uninstall is a no-op");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. Regression: existing multi-agent install/uninstall flow still behaves.
//    (Mirrors the installer section of tests/graphflow.test.ts.)
// ---------------------------------------------------------------------------
check("regression: multi-agent install/uninstall still works with the scoped default", () => {
  const s = createSandbox();
  try {
    for (const dir of [".cursor", ".claude", ".codex", ".vscode", ".config/opencode", ".config/zed", ".codeium/windsurf"]) {
      mkdirSync(join(s.home, dir), { recursive: true });
    }
    writeFileSync(join(s.home, ".claude", "CLAUDE.md"), "# User Custom Notes\nKeep this line.\n", "utf8");

    const report = installAllAgents({
      homeDir: s.home,
      appDataDir: s.appData,
      localAppDataDir: s.localAppData,
    });
    assert.ok(report.detectedAgents.some((d) => d.id === "cursor"));
    assert.ok(report.detectedAgents.some((d) => d.id === "claude-code"));
    assert.ok(report.detectedAgents.some((d) => d.id === "codex"));
    assert.ok(report.detectedAgents.some((d) => d.id === "vscode"));
    assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "mcp"));
    assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "skill"));
    assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "rule"));
    assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "hook"));

    const codexToml = readFileSync(join(s.home, ".codex", "config.toml"), "utf8");
    assert.ok(codexToml.includes("[mcp_servers.graphflow]"));
    assert.ok(
      readFileSync(join(s.home, ".codex", "skills", "graphflow", "SKILL.md"), "utf8").includes(
        "name: graphflow"
      )
    );

    const claudeMd = readFileSync(join(s.home, ".claude", "CLAUDE.md"), "utf8");
    assert.ok(claudeMd.includes("Keep this line.") && claudeMd.includes("<!-- GRAPHFLOW:BEGIN -->"));

    const removed = uninstallAllAgents({ homeDir: s.home });
    assert.ok(removed.length >= 10, `expected >= 10 removed items, got ${removed.length}`);
    const claudeMdAfter = readFileSync(join(s.home, ".claude", "CLAUDE.md"), "utf8");
    assert.ok(claudeMdAfter.includes("Keep this line."));
    assert.ok(!claudeMdAfter.includes("<!-- GRAPHFLOW:BEGIN -->"));
    assert.ok(!existsSync(join(s.home, ".dsh")), "isolated default must not create a DSH profile");
  } finally {
    s.cleanup();
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/${checks} installer-dsh check(s) FAILED:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}

console.log(`\nALL ${checks} INSTALLER-DSH CHECKS PASSED`);
