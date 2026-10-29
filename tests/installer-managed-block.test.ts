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
 *  - a real 3.8.0 install (legacy decorated Context-First block + old surgical
 *    block) migrates to exactly one current block: replacement matches only
 *    the BEGIN/END marker lines, never the body, so any legacy body self-heals;
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

/**
 * The full resident block a GraphFlow 3.8.0 install left in hosts' AGENTS.md /
 * CLAUDE.md (decorated marker). Kept verbatim as the legacy fixture: the
 * installer must replace it by marker match alone, with no content fingerprint.
 */
const LEGACY_CONTEXT_FIRST_BLOCK = [
  DECORATED_BEGIN,
  "## GraphFlow Context-First Rule",
  "",
  "GraphFlow is a local code knowledge-graph + context compression MCP server (10 tools).",
  "Before broad code exploration, implementation, debugging, review, or architecture",
  "questions in this project:",
  "",
  "1. Call `graphflow_context` with the task/query first.",
  "2. Use the returned `summary`, `anchors`, and `tokenBudget` as the primary context.",
  "3. Read full files only when anchors point there or compressed context is insufficient.",
  "4. For multi-step or ambiguous work, call `graphflow_plan` before implementing.",
  "5. After project changes, call `graphflow_index` to keep the graph fresh.",
  "6. The flywheel auto-closes: pending episodes are backfilled by Claude Code",
  "   hooks (or `graphflow_report_outcome`) by default; set GRAPHFLOW_AUTO_CAPTURE=0 to opt out.",
  "",
  "Pass `rootDir` = this project's absolute path. Never pass your home directory, AppData,",
  "or an unexpanded `${workspaceFolder}` placeholder — GraphFlow refuses unsafe workspace",
  "roots. If a call answers `unsafe workspace root`, retry it without `rootDir`.",
  "",
  "When using Cursor `CallMcpTool`, always pass `server` + `toolName` + `arguments`",
  "(e.g. server `\"graphflow\"` / `\"user-graphflow\"`, toolName `\"graphflow_context\"`).",
  "",
  "Tools: graphflow_context, graphflow_plan, graphflow_run, graphflow_report_outcome,",
  "graphflow_insight, graphflow_index, graphflow_artifact, graphflow_skill_insights,",
  "graphflow_skill_guide, graphflow_diagnose.",
  "",
  "Do not scan the whole repository or read many large files before trying GraphFlow",
  "context. Treat GraphFlow output as structured, token-saving context.",
  GRAPHFLOW_BLOCK_END,
].join("\n");

/** Resident block body as written before the slim-down (3.8.0 release text). */
const LEGACY_SURGICAL_BLOCK = [
  GRAPHFLOW_BLOCK_BEGIN,
  "# GraphFlow 3.1 (Token-First Surgical Mode / 外科手术省 Token 模式)",
  "",
  "Use GraphFlow's 4 surgical MCP tools (`gf_read`, `gf_edit`, `gf_exec`, `gf_macro`) to minimize token usage and prevent context rot:",
  "",
  "1. `gf_read`: Slice specific symbols (`targets: [\"file#symbol\"]`) or search by English/Chinese keywords (`q: \"keyword / 中文词\"`) with automatic cross-file type closure and `[Blast Radius]` call sites.",
  "2. `gf_edit`: Perform in-place symbol/line edits, bottom-up batch `edits`, or cross-repo `renameTo` with instant AST syntax, caller-arity, and struct-field contract guards.",
  "3. `gf_exec`: Run `cmd: \"affected-tests\"` or shell commands with dehydrated output (1-line `PASS` receipt; 5-line source window on failure; 3-strike loop circuit breaker).",
  "4. `gf_macro`: Run `action: \"mine-git\"` for zero-cold-start git co-change hints, or `action: \"run\"` to execute auto-compiled `.graphflow/macros/*.mjs` scripts.",
  GRAPHFLOW_BLOCK_END,
].join("\n");

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
// 3b. Real 3.8.0 install (decorated Context-First block + old surgical block):
//     marker-only matching migrates both legacy blocks to the one current block.
// ---------------------------------------------------------------------------
check("installed 3.8.0 block pair self-heals to the single current slim block", () => {
  const s = createSandbox();
  try {
    mkdirSync(join(s.home, ".zcode"), { recursive: true });
    // Byte shape of a real 3.8.0-era AGENTS.md: user header, legacy decorated
    // Context-First block, then the old surgical block appended after it.
    writeFileSync(
      s.agentsMd,
      ["# Agent OS", "", LEGACY_CONTEXT_FIRST_BLOCK, "", LEGACY_SURGICAL_BLOCK, ""].join("\n"),
      "utf8"
    );

    const report = s.install();
    assert.equal(
      report.results.find((r) => r.category === "rule")?.status,
      "updated",
      "migrating the legacy pair reports updated"
    );
    const healed = readFileSync(s.agentsMd, "utf8");
    assert.equal(beginMarkerLines(healed), 1, "exactly one BEGIN marker line remains");
    assert.equal(endMarkerLines(healed), 1, "exactly one END marker line remains");
    assert.equal(occurrences(healed, MANAGED_INSTRUCTION_BLOCK), 1, "new block in place");
    assert.ok(
      healed.trimEnd() === `# Agent OS\n\n${MANAGED_INSTRUCTION_BLOCK}`,
      "user header kept, legacy blocks replaced in place"
    );
    assert.ok(!healed.includes(DECORATED_BEGIN), "decorated BEGIN line gone");
    assert.ok(!healed.includes("Context-First Rule"), "legacy context-first body gone");
    assert.ok(!healed.includes("CallMcpTool"), "legacy CallMcpTool paragraph gone");
    assert.ok(!healed.includes("Token-First Surgical Mode"), "old surgical body gone");
    assert.ok(
      Buffer.byteLength(MANAGED_INSTRUCTION_BLOCK, "utf8") <= 900,
      "resident block stays within the 900-byte (~220-token) budget"
    );

    s.install();
    assert.equal(readFileSync(s.agentsMd, "utf8"), healed, "migrated file is idempotent");
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
