/**
 * GraphFlow — MCP registration idempotency tests.
 *
 * Regression suite for the codex-toml `[mcp_servers.<name>]` section regex that
 * used the `m` flag: `$` matched at every line end, so the lazy section body
 * matched zero characters and "the section" was just the header line. Symptoms:
 * every `graphflow install` after an upgrade appended one more
 * command/args pair inside the section; uninstall deleted only the header and
 * leaked the body into the preceding TOML table; legacy alias detection saw
 * alias names only. These tests pin the intended semantics instead:
 *
 *   - entry missing            -> installed
 *   - entry present, different -> updated (whole section replaced in place)
 *   - entry present, identical -> skipped (file untouched)
 *
 * Every sandbox (home / AppData / LocalAppData) is a fresh mkdtemp directory
 * passed through installer options, so the real HOME is never touched.
 *
 * Standalone: `npx tsx tests/installer-mcp-idempotency.test.ts`
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

interface Sandbox {
  root: string;
  home: string;
  appData: string;
  localAppData: string;
  codexTomlPath: string;
  cursorMcpPath: string;
  options: (extra?: Partial<UninstallAllAgentsOptions>) => InstallAllAgentsOptions;
  install: (extra?: Partial<InstallAllAgentsOptions>) => InstallAllAgentsReport;
  uninstall: (extra?: Partial<UninstallAllAgentsOptions>) => AgentInstallItemResult[];
  cleanup: () => void;
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "gf-mcp-idempotency-"));
  const home = join(root, "home");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  for (const dir of [home, appData, localAppData]) {
    mkdirSync(dir, { recursive: true });
  }
  const base = (): InstallAllAgentsOptions => ({
    homeDir: home,
    appDataDir: appData,
    localAppDataDir: localAppData,
  });
  return {
    root,
    home,
    appData,
    localAppData,
    codexTomlPath: join(home, ".codex", "config.toml"),
    cursorMcpPath: join(home, ".cursor", "mcp.json"),
    options: (extra = {}) => ({ ...base(), ...extra }),
    install: (extra = {}) => installAllAgents({ ...base(), ...extra }),
    uninstall: (extra = {}) => uninstallAllAgents({ ...base(), ...extra }),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The mcp result row for the codex config.toml target. */
function codexMcpResult(report: InstallAllAgentsReport, s: Sandbox): AgentInstallItemResult {
  const row = report.results.find(
    (r) => r.agentId === "codex" && r.category === "mcp" && r.targetPath === s.codexTomlPath
  );
  assert.ok(row, "install report must contain the codex config.toml mcp row");
  return row;
}

/** The mcp result row for the cursor mcp.json target. */
function cursorMcpResult(report: InstallAllAgentsReport, s: Sandbox): AgentInstallItemResult {
  const row = report.results.find(
    (r) => r.agentId === "cursor" && r.category === "mcp" && r.targetPath === s.cursorMcpPath
  );
  assert.ok(row, "install report must contain the cursor mcp.json mcp row");
  return row;
}

function writeCodexToml(s: Sandbox, lines: string[]): void {
  mkdirSync(join(s.home, ".codex"), { recursive: true });
  writeFileSync(s.codexTomlPath, `${lines.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// 1. codex-toml: install twice -> exactly one command/args pair, second skipped.
// ---------------------------------------------------------------------------
check("codex-toml reinstall is skipped and leaves exactly one command/args pair", () => {
  const s = createSandbox();
  try {
    const first = s.install({ agentIds: ["codex"] });
    assert.equal(codexMcpResult(first, s).status, "installed", "first install reports installed");
    const afterFirst = readFileSync(s.codexTomlPath, "utf8");
    assert.ok(afterFirst.includes("[mcp_servers.graphflow]"), "canonical section header written");

    const second = s.install({ agentIds: ["codex"] });
    assert.equal(
      codexMcpResult(second, s).status,
      "skipped",
      "second install with identical content must be skipped"
    );
    const afterSecond = readFileSync(s.codexTomlPath, "utf8");
    assert.equal(afterSecond, afterFirst, "skipped install must leave the file byte-identical");
    assert.equal(occurrenceCount(afterSecond, "command ="), 1, "exactly one command line");
    assert.equal(occurrenceCount(afterSecond, "args ="), 1, "exactly one args line");
    assert.equal(
      occurrenceCount(afterSecond, "[mcp_servers.graphflow]"),
      1,
      "exactly one section header"
    );
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. codex-toml: changed entry (different args/command) is replaced in place.
// ---------------------------------------------------------------------------
check("codex-toml changed entry is replaced in place, old body gone (updated)", () => {
  const s = createSandbox();
  try {
    writeCodexToml(s, [
      "[mcp_servers.graphflow]",
      'command = "old-node"',
      'args = ["old-arg"]',
      "",
      "[mcp_servers.other]",
      'command = "other-cmd"',
      "args = []",
    ]);

    const report = s.install({ agentIds: ["codex"] });
    assert.equal(
      codexMcpResult(report, s).status,
      "updated",
      "changed entry must report updated, not skipped"
    );

    const toml = readFileSync(s.codexTomlPath, "utf8");
    assert.ok(!toml.includes("old-node"), "old command must be gone");
    assert.ok(!toml.includes("old-arg"), "old args must be gone");
    assert.equal(occurrenceCount(toml, "command ="), 2, "one command line per section");
    assert.equal(occurrenceCount(toml, "args ="), 2, "one args line per section");
    assert.ok(toml.includes("[mcp_servers.other]"), "third-party section header preserved");
    assert.ok(toml.includes('command = "other-cmd"'), "third-party section body preserved");

    // Third-party section must still come after its own header, not inherit
    // graphflow's body (the old header-only replace left orphans behind).
    const graphflowIdx = toml.indexOf("[mcp_servers.graphflow]");
    const otherIdx = toml.indexOf("[mcp_servers.other]");
    assert.ok(graphflowIdx >= 0 && otherIdx > graphflowIdx, "section order preserved");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. codex-toml: config polluted by the old buggy installer self-heals to 1 pair.
// ---------------------------------------------------------------------------
check("codex-toml polluted section (3 stacked command/args pairs) converges to 1", () => {
  const s = createSandbox();
  try {
    writeCodexToml(s, [
      "[mcp_servers.other]",
      'command = "other-cmd"',
      "args = []",
      "",
      "[mcp_servers.graphflow]",
      'command = "node"',
      'args = ["/v1/server.js"]',
      'command = "node"',
      'args = ["/v2/server.js"]',
      'command = "node"',
      'args = ["/v3/server.js"]',
    ]);

    const report = s.install({ agentIds: ["codex"] });
    assert.equal(codexMcpResult(report, s).status, "updated");

    const toml = readFileSync(s.codexTomlPath, "utf8");
    assert.ok(!toml.includes("/v1/server.js"), "stacked v1 body removed");
    assert.ok(!toml.includes("/v2/server.js"), "stacked v2 body removed");
    assert.ok(!toml.includes("/v3/server.js"), "stacked v3 body removed");
    assert.equal(
      occurrenceCount(toml, "[mcp_servers.graphflow]"),
      1,
      "still exactly one graphflow section header"
    );
    const graphflowBlock = toml.slice(toml.indexOf("[mcp_servers.graphflow]"));
    assert.equal(occurrenceCount(graphflowBlock, "command ="), 1, "graphflow section has 1 command");
    assert.equal(occurrenceCount(graphflowBlock, "args ="), 1, "graphflow section has 1 args");
    assert.ok(toml.includes('command = "other-cmd"'), "third-party section untouched");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. JSON host (cursor): identical -> skipped; different -> updated in place.
// ---------------------------------------------------------------------------
check("cursor JSON: identical entry skipped, changed entry updated in place", () => {
  const s = createSandbox();
  try {
    mkdirSync(join(s.home, ".cursor"), { recursive: true });
    writeFileSync(
      s.cursorMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            graphflow: { command: "old-cmd", args: ["old-arg"] },
            other: { command: "other-cmd", args: [] },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const updated = s.install({ agentIds: ["cursor"] });
    assert.equal(
      cursorMcpResult(updated, s).status,
      "updated",
      "changed JSON entry must report updated"
    );
    const afterUpdate = JSON.parse(readFileSync(s.cursorMcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.notEqual(afterUpdate.mcpServers.graphflow.command, "old-cmd", "old command replaced");
    assert.notEqual(afterUpdate.mcpServers.graphflow.args.join(" "), "old-arg", "old args replaced");
    assert.ok(afterUpdate.mcpServers.other, "third-party JSON entry preserved");
    assert.equal(afterUpdate.mcpServers.other.command, "other-cmd");

    const snapshot = readFileSync(s.cursorMcpPath, "utf8");
    const skipped = s.install({ agentIds: ["cursor"] });
    assert.equal(
      cursorMcpResult(skipped, s).status,
      "skipped",
      "identical JSON entry must be skipped"
    );
    assert.equal(
      readFileSync(s.cursorMcpPath, "utf8"),
      snapshot,
      "skipped install must not rewrite the JSON file"
    );

    // Key order in the file must not matter: reorder graphflow's keys, keep the
    // same content, reinstall -> still skipped.
    const reordered = JSON.parse(snapshot) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    reordered.mcpServers.graphflow = {
      args: reordered.mcpServers.graphflow.args,
      command: reordered.mcpServers.graphflow.command,
    };
    writeFileSync(s.cursorMcpPath, `${JSON.stringify(reordered, null, 2)}\n`, "utf8");
    const reorderedReport = s.install({ agentIds: ["cursor"] });
    assert.equal(
      cursorMcpResult(reorderedReport, s).status,
      "skipped",
      "same content with reordered keys must still be skipped"
    );
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Uninstall: whole codex section deleted, preceding section intact, no orphans.
// ---------------------------------------------------------------------------
check("uninstall deletes the whole codex section and keeps the preceding section intact", () => {
  const s = createSandbox();
  try {
    // `other` BEFORE graphflow: the old header-only delete attached graphflow's
    // body to whatever table preceded it, corrupting `[mcp_servers.other]`.
    writeCodexToml(s, [
      "[mcp_servers.other]",
      'command = "other-cmd"',
      "args = []",
    ]);
    s.install({ agentIds: ["codex"] });
    const before = readFileSync(s.codexTomlPath, "utf8");
    assert.ok(before.includes("[mcp_servers.other]"));
    assert.ok(before.includes("[mcp_servers.graphflow]"));

    const removed = s.uninstall({ agentIds: ["codex"] });
    assert.ok(
      removed.some(
        (r) => r.agentId === "codex" && r.category === "mcp" && r.targetPath === s.codexTomlPath
      ),
      "uninstall reports the codex config.toml target"
    );

    const after = readFileSync(s.codexTomlPath, "utf8");
    assert.ok(!after.includes("[mcp_servers.graphflow]"), "graphflow header removed");
    assert.ok(
      !after.toLowerCase().includes("graphflow"),
      "graphflow body removed too — no orphan launcher lines of any launcher shape"
    );
    assert.equal(occurrenceCount(after, "command ="), 1, "only other's command line remains");
    assert.equal(occurrenceCount(after, "args ="), 1, "only other's args line remains");
    assert.ok(after.includes("[mcp_servers.other]"), "preceding section header preserved");
    assert.ok(after.includes('command = "other-cmd"'), "preceding section body preserved");
    assert.ok(!/\n\n\n/.test(after), "no doubled blank lines left behind");
    assert.ok(after.endsWith("\n"), "file keeps the single trailing newline style");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Legacy alias prune: name hides "graphflow" but args launch graphflow.
// ---------------------------------------------------------------------------
check("legacy TOML alias without 'graphflow' in its name is detected via its body and pruned", () => {
  const s = createSandbox();
  try {
    writeCodexToml(s, [
      "[mcp_servers.gf-legacy]",
      'command = "node"',
      'args = ["/legacy/dist/graphflow-mcp.js"]',
      "",
      "[mcp_servers.context7]",
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
    ]);

    const report = s.install({ agentIds: ["codex"] });
    assert.ok(
      report.results.some(
        (r) =>
          r.status === "removed" &&
          (r.message ?? "").includes('legacy MCP alias "gf-legacy" removed')
      ),
      "prune must report the gf-legacy alias removal"
    );

    const toml = readFileSync(s.codexTomlPath, "utf8");
    assert.ok(!toml.includes("gf-legacy"), "alias header removed, no orphan alias lines");
    assert.ok(
      !toml.includes("/legacy/dist/graphflow-mcp.js"),
      "alias body removed too, not only the header (the body is what identifies the alias)"
    );
    assert.ok(toml.includes("[mcp_servers.context7]"), "unrelated section header preserved");
    assert.ok(toml.includes("@upstash/context7-mcp"), "unrelated section body preserved");
    assert.ok(toml.includes("[mcp_servers.graphflow]"), "canonical section installed");
    assert.equal(
      occurrenceCount(toml, "[mcp_servers.graphflow]"),
      1,
      "exactly one canonical section"
    );
  } finally {
    s.cleanup();
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/${checks} installer-mcp-idempotency check(s) FAILED:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}

console.log(`\nALL ${checks} INSTALLER-MCP-IDEMPOTENCY CHECKS PASSED`);
