/**
 * GraphFlow — managed instruction block upsert / removal tests.
 *
 * Regression suite for the "managed block duplicates on every install" bug:
 * the old exact-substring `indexOf(GRAPHFLOW_BLOCK_BEGIN)` probe never matched
 * decorated BEGIN lines (`<!-- GRAPHFLOW:BEGIN managed block — ... -->`) left
 * by an older release, so installs kept appending blocks, and uninstalls left
 * the malformed markers behind.
 *
 * Covers, through installAllAgents / uninstallAllAgents / status (zcode
 * profile scoped via agentIds, ~/.zcode/AGENTS.md is a managed-md surface):
 *  - empty / marker-free file -> exactly one canonical block after install,
 *    and a second install is a byte-identical no-op;
 *  - an outdated block body is replaced in place, user context preserved;
 *  - a corrupted file (decorated BEGIN + 3 complete blocks + dangling BEGIN +
 *    stray END) self-heals to exactly one current block with no marker
 *    residue and user content intact;
 *  - uninstall strips every marker form (also without a prior install) and
 *    deletes the file when nothing user-owned remains;
 *  - registration status detects decorated-marker files as rule-registered.
 *
 * Every sandbox (home / AppData / LocalAppData / workspace / DSH_HOME) is a
 * fresh mkdtemp directory passed through installer options; the real HOME and
 * real ~/.zcode are never touched.
 *
 * Standalone: `npx tsx tests/installer-managed-block.test.ts`
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAPHFLOW_BLOCK_BEGIN,
  GRAPHFLOW_BLOCK_END,
  MANAGED_INSTRUCTION_BLOCK,
  getAgentRegistrationStatus,
  installAllAgents,
  uninstallAllAgents,
  type InstallAllAgentsOptions,
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

interface Sandbox {
  root: string;
  home: string;
  agentsMd: string;
  baseOptions: () => InstallAllAgentsOptions;
  install: () => ReturnType<typeof installAllAgents>;
  uninstall: () => ReturnType<typeof uninstallAllAgents>;
  cleanup: () => void;
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "gf-managed-block-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const baseOptions = (): InstallAllAgentsOptions => ({
    homeDir: home,
    appDataDir: join(root, "appdata"),
    localAppDataDir: join(root, "localappdata"),
    workspaceRoot: join(root, "workspace"),
    dshHome: join(root, "dsh-home"),
  });
  return {
    root,
    home,
    agentsMd: join(home, ".zcode", "AGENTS.md"),
    baseOptions,
    // agentIds forces the zcode profile into scope without needing host markers.
    install: () => installAllAgents({ ...baseOptions(), agentIds: ["zcode"] }),
    uninstall: () => uninstallAllAgents({ ...baseOptions(), agentIds: ["zcode"] }),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Decorated BEGIN line as written by an older GraphFlow release. */
const DECORATED_BEGIN = "<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->";

function beginMarkerLines(content: string): number {
  return content.split("\n").filter((line) => line.trim().startsWith("<!-- GRAPHFLOW:BEGIN")).length;
}

function endMarkerLines(content: string): number {
  return content.split("\n").filter((line) => line.trim().startsWith("<!-- GRAPHFLOW:END")).length;
}

function occurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

/**
 * The corrupted shape observed in a real user's AGENTS.md: a decorated legacy
 * block, three complete duplicated blocks, a dangling BEGIN fragment and a
 * stray END line, all interleaved with user-owned content that must survive.
 */
function buildCorruptedFile(): string {
  const legacyBlock = [
    DECORATED_BEGIN,
    "## GraphFlow Context-First Rule",
    "",
    "Old instructions from a previous release.",
    GRAPHFLOW_BLOCK_END,
  ].join("\n");
  const danglingFragment = [GRAPHFLOW_BLOCK_BEGIN, "stale half-written block body"].join("\n");
  return [
    legacyBlock,
    "",
    "# User-owned project notes",
    "Keep my workflow notes.",
    "",
    MANAGED_INSTRUCTION_BLOCK,
    GRAPHFLOW_BLOCK_END, // stray END right after a complete block
    "",
    MANAGED_INSTRUCTION_BLOCK,
    "",
    MANAGED_INSTRUCTION_BLOCK,
    "",
    danglingFragment,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 1. Empty / missing file: exactly one canonical block; reinstall is a no-op.
// ---------------------------------------------------------------------------
check("empty and missing files get exactly one canonical block; reinstall is byte-identical", () => {
  const s = createSandbox();
  try {
    // Missing file -> created with just the canonical block.
    const report = s.install();
    assert.ok(existsSync(s.agentsMd), "AGENTS.md created");
    assert.equal(readFileSync(s.agentsMd, "utf8"), `${MANAGED_INSTRUCTION_BLOCK}\n`);
    assert.equal(
      report.results.find((r) => r.category === "rule")?.status,
      "installed",
      "first install reports installed"
    );

    s.install();
    assert.equal(
      readFileSync(s.agentsMd, "utf8"),
      `${MANAGED_INSTRUCTION_BLOCK}\n`,
      "reinstall on a canonical file is a byte-identical no-op"
    );

    // Existing-but-empty file -> same result, without leading blank lines.
    writeFileSync(s.agentsMd, "", "utf8");
    s.install();
    assert.equal(readFileSync(s.agentsMd, "utf8"), `${MANAGED_INSTRUCTION_BLOCK}\n`);
    writeFileSync(s.agentsMd, "   \n\n", "utf8");
    s.install();
    assert.equal(readFileSync(s.agentsMd, "utf8"), `${MANAGED_INSTRUCTION_BLOCK}\n`);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Marker-free user file: block appended once; second install byte-identical.
// ---------------------------------------------------------------------------
check("marker-free user file gets one appended block and stays byte-identical on reinstall", () => {
  const s = createSandbox();
  try {
    mkdirSync(join(s.home, ".zcode"), { recursive: true });
    writeFileSync(s.agentsMd, "# My agent notes\nUse tool X.\n", "utf8");
    s.install();
    const afterFirst = readFileSync(s.agentsMd, "utf8");
    assert.equal(afterFirst, `# My agent notes\nUse tool X.\n\n${MANAGED_INSTRUCTION_BLOCK}\n`);
    assert.equal(beginMarkerLines(afterFirst), 1);
    assert.equal(endMarkerLines(afterFirst), 1);

    s.install();
    assert.equal(
      readFileSync(s.agentsMd, "utf8"),
      afterFirst,
      "second install must not change a single byte"
    );
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Outdated block body: replaced in place, user context preserved.
// ---------------------------------------------------------------------------
check("outdated block body is replaced in place with the current block", () => {
  const s = createSandbox();
  try {
    mkdirSync(join(s.home, ".zcode"), { recursive: true });
    const oldBlock = [
      GRAPHFLOW_BLOCK_BEGIN,
      "# GraphFlow 2.0 (old release)",
      "old body line",
      GRAPHFLOW_BLOCK_END,
    ].join("\n");
    writeFileSync(s.agentsMd, `# My header\n\n${oldBlock}\n\nSome user footer text.\n`, "utf8");

    const report = s.install();
    assert.equal(
      report.results.find((r) => r.category === "rule")?.status,
      "updated",
      "replacing an outdated block reports updated"
    );
    assert.equal(
      readFileSync(s.agentsMd, "utf8"),
      `# My header\n\n${MANAGED_INSTRUCTION_BLOCK}\n\nSome user footer text.\n`,
      "block replaced in place, surrounding user content untouched"
    );
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Corrupted file self-heals: exactly one current block, no residue.
// ---------------------------------------------------------------------------
check("corrupted file (decorated BEGIN + 3 blocks + dangling BEGIN + stray END) self-heals", () => {
  const s = createSandbox();
  try {
    mkdirSync(join(s.home, ".zcode"), { recursive: true });
    writeFileSync(s.agentsMd, buildCorruptedFile(), "utf8");

    s.install();
    const healed = readFileSync(s.agentsMd, "utf8");
    assert.equal(beginMarkerLines(healed), 1, "exactly one BEGIN marker line remains");
    assert.equal(endMarkerLines(healed), 1, "exactly one END marker line remains");
    assert.equal(occurrences(healed, MANAGED_INSTRUCTION_BLOCK), 1, "exactly one current block");
    assert.ok(healed.includes("# User-owned project notes"), "user section header preserved");
    assert.ok(healed.includes("Keep my workflow notes."), "user body text preserved");
    assert.ok(!healed.includes("Old instructions from a previous release."), "legacy block body gone");
    assert.ok(!healed.includes("stale half-written block body"), "dangling fragment gone");
    assert.ok(!healed.includes(DECORATED_BEGIN), "decorated BEGIN line gone");
    assert.ok(healed.endsWith("\n"), "file ends with a newline");

    // Stable afterwards: a follow-up install is a byte-identical no-op.
    s.install();
    assert.equal(readFileSync(s.agentsMd, "utf8"), healed, "healed file is idempotent");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Uninstall cleans every marker form and keeps user content.
// ---------------------------------------------------------------------------
check("uninstall after install removes the block and keeps user content", () => {
  const s = createSandbox();
  try {
    mkdirSync(join(s.home, ".zcode"), { recursive: true });
    writeFileSync(s.agentsMd, "# My agent notes\nUse tool X.\n", "utf8");
    s.install();

    const removed = s.uninstall();
    assert.ok(
      removed.some((r) => r.category === "rule" && r.status === "removed"),
      "rule removal reported"
    );
    const after = readFileSync(s.agentsMd, "utf8");
    assert.equal(beginMarkerLines(after), 0, "no BEGIN marker left");
    assert.equal(endMarkerLines(after), 0, "no END marker left");
    assert.ok(after.includes("# My agent notes") && after.includes("Use tool X."));
    assert.ok(!after.includes("GraphFlow"), "no graphflow-managed text left");

    // Second uninstall: nothing left to remove.
    const second = s.uninstall();
    assert.equal(second.filter((r) => r.category === "rule").length, 0);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Uninstall also repairs a corrupted file without a prior install, and
//    deletes the file when nothing user-owned remains.
// ---------------------------------------------------------------------------
check("uninstall repairs a corrupted file directly and deletes a block-only file", () => {
  const s = createSandbox();
  try {
    // Corrupted shapes cleaned even without install (e.g. install --agents x).
    mkdirSync(join(s.home, ".zcode"), { recursive: true });
    writeFileSync(s.agentsMd, buildCorruptedFile(), "utf8");
    const removed = s.uninstall();
    assert.ok(
      removed.some((r) => r.category === "rule" && r.status === "removed"),
      "corrupted markers count as removable graphflow content"
    );
    const after = readFileSync(s.agentsMd, "utf8");
    assert.equal(beginMarkerLines(after), 0, "no BEGIN marker left");
    assert.equal(endMarkerLines(after), 0, "no END marker left");
    assert.ok(after.includes("# User-owned project notes"), "user content survives");
    assert.ok(after.includes("Keep my workflow notes."));
    assert.ok(!after.includes("Old instructions from a previous release."));
    assert.ok(!after.includes("stale half-written block body"));

    // Block-only file (no user content): uninstall removes the whole file.
    writeFileSync(s.agentsMd, `${MANAGED_INSTRUCTION_BLOCK}\n`, "utf8");
    s.uninstall();
    assert.ok(!existsSync(s.agentsMd), "block-only AGENTS.md is deleted by uninstall");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. Registration status uses the same line-level marker detection.
// ---------------------------------------------------------------------------
check("registration status detects decorated-marker files as rule-registered", () => {
  const s = createSandbox();
  try {
    mkdirSync(join(s.home, ".zcode"), { recursive: true });
    // Only a decorated legacy block: no exact `<!-- GRAPHFLOW:BEGIN -->`
    // substring anywhere, which the old `includes()` probe missed.
    writeFileSync(
      s.agentsMd,
      [DECORATED_BEGIN, "legacy body", GRAPHFLOW_BLOCK_END, "", "# user note\n"].join("\n"),
      "utf8"
    );
    const before = getAgentRegistrationStatus({ ...s.baseOptions(), agentIds: ["zcode"] });
    assert.equal(before[0]?.rule, true, "decorated block reports as registered");

    s.uninstall();
    const after = getAgentRegistrationStatus({ ...s.baseOptions(), agentIds: ["zcode"] });
    assert.equal(after[0]?.rule, false, "markers gone after uninstall");
    assert.ok(readFileSync(s.agentsMd, "utf8").includes("# user note"), "user note kept");
  } finally {
    s.cleanup();
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/${checks} installer-managed-block check(s) FAILED:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}

console.log(`\nALL ${checks} INSTALLER-MANAGED-BLOCK CHECKS PASSED`);
