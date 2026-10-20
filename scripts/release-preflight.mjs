#!/usr/bin/env node
/**
 * GraphFlow release preflight (`scripts/release-preflight.mjs`).
 *
 * Read-only release gate: verifies version consistency, required artifacts,
 * package metadata, MCP registration, skill frontmatter, and the expected
 * content of the existing GitHub Actions workflows. The two expensive checks
 * are opt-in:
 *   --with-tests    run `npm test` (spawned, no shell on POSIX)
 *   --with-package  `npm pack --dry-run --json` + local `vsce package` dry run
 *                   (vsce is skipped when the binary is not installed locally)
 *
 * It NEVER publishes anything and never reads credentials. It does not rewrite
 * the workflows it asserts on.
 *
 * Usage:
 *   node scripts/release-preflight.mjs [--fast] [--json]
 *     [--with-tests] [--with-package] [--help]
 *
 * Exported helpers are pure where possible so tests can call them against
 * fixture directories with mkdtemp().
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root = parent dir of scripts/. */
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const IS_WINDOWS = process.platform === "win32";
const NPM_COMMAND = IS_WINDOWS ? "npm.cmd" : "npm";
const SUBPROCESS_TIMEOUT_MS = 300_000;
/**
 * The full suite is 40 test files and takes ~7 minutes locally (it was ~4 when
 * the 5-minute leash was set), so `npm test` needs its own, longer timeout —
 * otherwise release gating fails with ETIMEDOUT on a suite that is passing.
 */
const NPM_TEST_TIMEOUT_MS = 900_000;

function quoteShellArg(value) {
  return /[\s"'&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Spawn without credentials and without a shell on POSIX. On Windows the npm
 * and vsce entry points are `.cmd` shims, which need a shell; the command line
 * is assembled from constant flags plus local paths only (never user input).
 */
function runSpawn(command, args, options) {
  if (IS_WINDOWS) {
    const commandLine = [command, ...args].map(quoteShellArg).join(" ");
    return spawnSync(commandLine, { ...options, shell: true });
  }
  return spawnSync(command, args, { ...options, shell: false });
}

/** Artifacts that must exist in a built working tree before releasing. */
export const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "vscode-extension/package.json",
  "dist/index.js",
  "dist/mcp-server.js",
  "dist/cli.js",
  "dist/tree-sitter-engine.js",
  "skills/graphflow/SKILL.md",
  "mcp.json",
  "LICENSE",
  "README.md",
  "README.zh.md",
  "VSIX-INSTALL.md",
];

/** Files that must be inside the npm tarball (validated against npm pack). */
export const REQUIRED_PACK_FILES = [
  "package.json",
  "dist/index.js",
  "dist/mcp-server.js",
  "dist/cli.js",
  "dist/tree-sitter-engine.js",
  "skills/graphflow/SKILL.md",
  "mcp.json",
  "LICENSE",
  "README.md",
  "README.zh.md",
  "VSIX-INSTALL.md",
];

/** Paths that must never ship in the npm tarball. */
export const FORBIDDEN_PACK_PATTERNS = [
  /^tests\//,
  /^src\//,
  /^\.github\//,
  /^benchmarks\//,
  /^vscode-extension\//,
  /^coverage\//,
  /^scripts\//,
  /\.vsix$/,
  /\.tgz$/,
];

/**
 * Key strings each existing workflow must keep containing (audit only — the
 * workflows are never edited by this script).
 */
export const WORKFLOW_CONTRACTS = [
  {
    file: "ci.yml",
    name: "workflow-ci",
    tokens: [
      "pull_request",
      "push:",
      "workflow_dispatch",
      "matrix",
      "node-version",
      "npm ci",
      "npm run build",
      "npm test",
      "actions/checkout@v4",
      "actions/setup-node@v4",
    ],
  },
  {
    file: "publish-npm.yml",
    name: "workflow-publish-npm",
    tokens: [
      "tags:",
      "v*",
      "npm ci",
      "npm run build",
      "npm test",
      "npm publish",
      "NODE_AUTH_TOKEN",
      "id-token: write",
      "workflow_dispatch",
    ],
  },
  {
    file: "publish-marketplace.yml",
    name: "workflow-publish-marketplace",
    tokens: [
      "tags:",
      "v*",
      "vsce package",
      "gh release create",
      "vsce publish",
      "ovsx publish",
      "workflow_dispatch",
    ],
  },
];

function pass(name, detail) {
  return detail ? { name, ok: true, detail } : { name, ok: true };
}

function fail(name, detail) {
  return { name, ok: false, detail };
}

function skipped(name, detail) {
  return { name, ok: true, skipped: true, detail };
}

export function readTextFile(filePath) {
  try {
    return { ok: true, value: readFileSync(filePath, "utf8").replace(/^\uFEFF/, "") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readJsonFile(filePath) {
  const text = readTextFile(filePath);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** First `vX.Y.Z` in the first 6000 chars of the README (tagline area). */
export function extractTaglineVersion(text) {
  const match = /\bv(\d+\.\d+\.\d+)\b/.exec(text.slice(0, 6000));
  return match ? match[1] : undefined;
}

/** Collect `{ source, version }` facts from every release-versioned location. */
export function collectVersionFacts(rootDir) {
  const facts = [];
  const errors = [];

  const pkg = readJsonFile(join(rootDir, "package.json"));
  if (pkg.ok && pkg.value && typeof pkg.value === "object") {
    facts.push({ source: "package.json", version: pkg.value.version });
  } else {
    errors.push("package.json: missing or unreadable");
  }

  const lock = readJsonFile(join(rootDir, "package-lock.json"));
  if (lock.ok && lock.value && typeof lock.value === "object") {
    facts.push({ source: "package-lock.json", version: lock.value.version });
    const lockRoot = lock.value.packages && lock.value.packages[""];
    if (lockRoot && typeof lockRoot === "object") {
      facts.push({ source: 'package-lock.json packages[""]', version: lockRoot.version });
    } else {
      errors.push('package-lock.json: missing packages[""] entry');
    }
  } else {
    errors.push("package-lock.json: missing or unreadable");
  }

  const extensionPkg = readJsonFile(join(rootDir, "vscode-extension", "package.json"));
  if (extensionPkg.ok && extensionPkg.value && typeof extensionPkg.value === "object") {
    facts.push({ source: "vscode-extension/package.json", version: extensionPkg.value.version });
  } else {
    errors.push("vscode-extension/package.json: missing or unreadable");
  }

  for (const [source, file] of [
    ["README.md tagline", "README.md"],
    ["README.zh.md tagline", "README.zh.md"],
  ]) {
    const text = readTextFile(join(rootDir, file));
    if (!text.ok) {
      errors.push(`${file}: missing or unreadable`);
      continue;
    }
    const version = extractTaglineVersion(text.value);
    if (!version) {
      errors.push(`${file}: no vX.Y.Z tagline found near the top`);
      continue;
    }
    facts.push({ source, version });
  }

  return { facts, errors };
}

export function checkVersionConsistency(rootDir) {
  const { facts, errors } = collectVersionFacts(rootDir);
  const invalid = facts.filter(
    (fact) => typeof fact.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(fact.version)
  );
  if (errors.length > 0 || invalid.length > 0) {
    return fail(
      "version-consistency",
      [...errors, ...invalid.map((fact) => `${fact.source}: invalid version "${fact.version}"`)].join("; ")
    );
  }
  const versions = [...new Set(facts.map((fact) => fact.version))];
  if (versions.length > 1) {
    return fail(
      "version-consistency",
      `version mismatch: ${facts.map((fact) => `${fact.source}=${fact.version}`).join(", ")}`
    );
  }
  return pass(
    "version-consistency",
    `${facts.length} sources agree on ${versions[0]} (${facts.map((fact) => fact.source).join(", ")})`
  );
}

export function checkRequiredFiles(rootDir) {
  const missing = REQUIRED_FILES.filter((relPath) => !isFile(join(rootDir, relPath)));
  if (missing.length > 0) {
    const distMissing = missing.some((relPath) => relPath.startsWith("dist/"));
    const hint = distMissing ? " — run `npm run build` first (dist/ is gitignored)" : "";
    return fail("required-files", `missing: ${missing.join(", ")}${hint}`);
  }
  return pass("required-files", `${REQUIRED_FILES.length} required files present`);
}

export function checkMcpConfig(rootDir) {
  const parsed = readJsonFile(join(rootDir, "mcp.json"));
  if (!parsed.ok) return fail("mcp-config", `mcp.json: ${parsed.error}`);
  const servers = parsed.value?.mcpServers;
  const graphflow = servers && typeof servers === "object" ? servers.graphflow : undefined;
  if (!graphflow || typeof graphflow !== "object") {
    return fail("mcp-config", "mcp.json: missing mcpServers.graphflow entry");
  }
  if (typeof graphflow.command !== "string" || graphflow.command.length === 0) {
    return fail("mcp-config", "mcp.json: mcpServers.graphflow.command is missing");
  }
  const args = Array.isArray(graphflow.args) ? graphflow.args : [];
  if (!args.some((arg) => typeof arg === "string" && arg.includes("graphflow-mcp"))) {
    return fail("mcp-config", "mcp.json: mcpServers.graphflow.args must launch graphflow-mcp");
  }
  return pass("mcp-config", `stdio launcher: ${graphflow.command} ${args.join(" ")}`.trim());
}

export function checkWorkflows(rootDir) {
  return WORKFLOW_CONTRACTS.map((contract) => {
    const filePath = join(rootDir, ".github", "workflows", contract.file);
    const text = readTextFile(filePath);
    if (!text.ok) {
      return fail(contract.name, `.github/workflows/${contract.file}: missing or unreadable`);
    }
    const normalized = text.value.replace(/\r\n/g, "\n");
    const missing = contract.tokens.filter((token) => !normalized.includes(token));
    if (missing.length > 0) {
      return fail(
        contract.name,
        `.github/workflows/${contract.file}: missing expected content: ${missing.join(", ")}`
      );
    }
    return pass(contract.name, `.github/workflows/${contract.file}: ${contract.tokens.length} key strings present`);
  });
}

export function checkSkillFrontmatter(rootDir) {
  const filePath = join(rootDir, "skills", "graphflow", "SKILL.md");
  const text = readTextFile(filePath);
  if (!text.ok) return fail("skill-frontmatter", "skills/graphflow/SKILL.md: missing or unreadable");
  const normalized = text.value.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return fail("skill-frontmatter", "skills/graphflow/SKILL.md: missing YAML frontmatter");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return fail("skill-frontmatter", "skills/graphflow/SKILL.md: unterminated YAML frontmatter");
  const frontmatter = normalized.slice(4, end);
  const problems = [];
  if (!/^name:\s*graphflow\s*$/m.test(frontmatter)) problems.push("frontmatter name must be graphflow");
  if (!/^description:\s*\S+/m.test(frontmatter)) problems.push("frontmatter description is missing");
  if (problems.length > 0) return fail("skill-frontmatter", problems.join("; "));
  return pass("skill-frontmatter", "SKILL.md frontmatter has name/description");
}

export function checkPackageMetadata(rootDir) {
  const parsed = readJsonFile(join(rootDir, "package.json"));
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return fail("package-metadata", `package.json: ${parsed.ok ? "not an object" : parsed.error}`);
  }
  const pkg = parsed.value;
  const problems = [];

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(pkg.version ?? ""))) {
    problems.push(`version "${pkg.version}" is not semver`);
  }
  for (const field of ["main", "types"]) {
    const target = pkg[field];
    if (typeof target !== "string" || target.length === 0 || !isFile(join(rootDir, target))) {
      problems.push(`${field} target "${target}" is missing`);
    }
  }
  const bins = pkg.bin && typeof pkg.bin === "object" ? Object.entries(pkg.bin) : [];
  if (bins.length === 0) problems.push("bin entries are missing");
  for (const [binName, target] of bins) {
    if (typeof target !== "string" || !isFile(join(rootDir, target))) {
      problems.push(`bin "${binName}" target "${target}" is missing`);
    }
  }
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  for (const required of ["dist", "skills", "mcp.json", "README.md", "README.zh.md", "LICENSE", "VSIX-INSTALL.md"]) {
    if (!files.includes(required)) problems.push(`files[] is missing "${required}"`);
  }
  if (pkg.scripts?.prepublishOnly !== "npm run build") {
    problems.push('scripts.prepublishOnly must be "npm run build" so publishes always rebuild dist/');
  }
  if (!pkg.engines || typeof pkg.engines.node !== "string") {
    problems.push("engines.node is missing");
  }

  if (problems.length > 0) return fail("package-metadata", problems.join("; "));
  return pass("package-metadata", "main/types/bin/files/prepublishOnly look release-ready");
}

/** Pure validation of one `npm pack --dry-run --json` entry. */
export function validatePackEntry(entry, expectedVersion, requiredFiles = REQUIRED_PACK_FILES) {
  if (!entry || typeof entry !== "object") return { ok: false, detail: "npm pack output is empty" };
  const problems = [];
  if (typeof entry.id !== "string" || !entry.id.includes("@")) {
    problems.push("pack id is missing");
  }
  if (entry.version !== expectedVersion) {
    problems.push(`pack version ${JSON.stringify(entry.version)} does not match package version ${expectedVersion}`);
  }
  if (typeof entry.filename !== "string" || !entry.filename.endsWith(`-${expectedVersion}.tgz`)) {
    problems.push(`pack filename "${entry.filename}" does not match version ${expectedVersion}`);
  }
  const paths = new Set(
    (Array.isArray(entry.files) ? entry.files : [])
      .map((file) => (file && typeof file === "object" && typeof file.path === "string" ? file.path : undefined))
      .filter((relPath) => typeof relPath === "string")
  );
  for (const required of requiredFiles) {
    if (!paths.has(required)) problems.push(`tarball is missing "${required}"`);
  }
  for (const relPath of paths) {
    const forbidden = FORBIDDEN_PACK_PATTERNS.find((pattern) => pattern.test(relPath));
    if (forbidden) problems.push(`tarball must not include "${relPath}"`);
  }
  if (!Number.isFinite(entry.unpackedSize) || entry.unpackedSize <= 0) {
    problems.push("pack unpackedSize must be positive");
  }
  if (problems.length > 0) return { ok: false, detail: problems.join("; "), paths: [...paths] };
  return {
    ok: true,
    detail: `${paths.size} files, ${(entry.unpackedSize / 1024).toFixed(0)} KiB unpacked`,
    paths: [...paths],
  };
}

/** Run `npm pack --dry-run --json` in cwd (no publish, no network needed). */
export function runNpmPackDryRun(rootDir) {
  const result = runSpawn(NPM_COMMAND, ["pack", "--dry-run", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env },
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const tail = `${result.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
    return { ok: false, error: `npm pack exited with ${result.status}${tail ? `\n${tail}` : ""}` };
  }
  try {
    const parsed = JSON.parse(`${result.stdout ?? ""}`.trim());
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return { ok: true, entry };
  } catch (error) {
    return {
      ok: false,
      error: `unparseable npm pack JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function checkPackContents(rootDir) {
  const pkg = readJsonFile(join(rootDir, "package.json"));
  if (!pkg.ok || !pkg.value) return fail("npm-pack", "package.json: missing or unreadable");
  const pack = runNpmPackDryRun(rootDir);
  if (!pack.ok) return fail("npm-pack", pack.error);
  const validation = validatePackEntry(pack.entry, pkg.value.version);
  return validation.ok
    ? pass("npm-pack", validation.detail)
    : fail("npm-pack", validation.detail);
}

/** Locate a locally installed `vsce` binary (root or vscode-extension node_modules). */
export function findVsceBinary(rootDir) {
  const executable = IS_WINDOWS ? "vsce.cmd" : "vsce";
  const candidates = [
    join(rootDir, "node_modules", ".bin", executable),
    join(rootDir, "vscode-extension", "node_modules", ".bin", executable),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Optional VSIX packaging dry run in a temp dir. Skipped when `vsce` is not
 * installed locally (no network fetch of publishing tooling is performed).
 */
export function checkVscePackage(rootDir) {
  const vscePath = findVsceBinary(rootDir);
  if (!vscePath) {
    return skipped("vsce-package", "vsce not installed locally; skipped (install @vscode/vsce to enable)");
  }
  const extensionPkg = readJsonFile(join(rootDir, "vscode-extension", "package.json"));
  if (!extensionPkg.ok || !extensionPkg.value) {
    return fail("vsce-package", "vscode-extension/package.json: missing or unreadable");
  }
  const version = extensionPkg.value.version;
  const outDir = mkdtempSync(join(tmpdir(), "gf-preflight-vsix-"));
  const outFile = join(outDir, `graphflow-${version}.vsix`);
  try {
    const result = runSpawn(
      vscePath,
      ["package", "--no-dependencies", "-o", outFile],
      {
        cwd: join(rootDir, "vscode-extension"),
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env },
      }
    );
    if (result.error) return fail("vsce-package", result.error.message);
    if (result.status !== 0) {
      const tail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-8).join("\n");
      return fail("vsce-package", `vsce package exited with ${result.status}${tail ? `\n${tail}` : ""}`);
    }
    if (!isFile(outFile) || statSync(outFile).size <= 0) {
      return fail("vsce-package", `vsce package did not produce ${outFile}`);
    }
    return pass("vsce-package", `packaged graphflow-${version}.vsix (${statSync(outFile).size} bytes, temp)`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Optional `npm test` run (spawned; no shell on POSIX). */
export function checkNpmTest(rootDir) {
  const result = runSpawn(NPM_COMMAND, ["test"], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: NPM_TEST_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env },
  });
  if (result.error) return fail("npm-test", result.error.message);
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
    return fail("npm-test", `npm test exited with ${result.status}${tail ? `\n${tail}` : ""}`);
  }
  return pass("npm-test", "npm test passed");
}

/** Parse CLI argv. `--fast` forces the static-only mode (wins over --with-*). */
export function parseArgs(argv) {
  const options = { fast: false, json: false, withTests: false, withPackage: false, help: false };
  for (const arg of argv) {
    if (arg === "--fast") options.fast = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--with-tests") options.withTests = true;
    else if (arg === "--with-package") options.withPackage = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.fast) {
    options.withTests = false;
    options.withPackage = false;
  }
  return options;
}

/** Run the whole preflight and return a structured report. */
export function runPreflight(options = {}) {
  const rootDir = resolve(options.rootDir ?? REPO_ROOT);
  const checks = [];

  checks.push(checkVersionConsistency(rootDir));
  checks.push(checkRequiredFiles(rootDir));
  checks.push(checkMcpConfig(rootDir));
  checks.push(...checkWorkflows(rootDir));
  checks.push(checkSkillFrontmatter(rootDir));
  checks.push(checkPackageMetadata(rootDir));

  if (options.withTests) checks.push(checkNpmTest(rootDir));
  if (options.withPackage) {
    checks.push(checkPackContents(rootDir));
    checks.push(checkVscePackage(rootDir));
  }

  const pkg = readJsonFile(join(rootDir, "package.json"));
  const version = pkg.ok && pkg.value ? pkg.value.version : "unknown";
  const failures = checks.filter((check) => !check.ok);
  return {
    ok: failures.length === 0,
    version,
    rootDir,
    mode: options.fast ? "fast" : options.withTests || options.withPackage ? "extended" : "static",
    withTests: Boolean(options.withTests),
    withPackage: Boolean(options.withPackage),
    checks,
    failures: failures.length,
  };
}

export function formatReport(report) {
  const lines = [`GraphFlow release preflight — v${report.version}`, `Root: ${report.rootDir}`, `Mode: ${report.mode}`];
  lines.push("");
  for (const check of report.checks) {
    const tag = check.skipped ? "SKIP" : check.ok ? "PASS" : "FAIL";
    lines.push(`${tag} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? `RELEASE PREFLIGHT PASSED (${report.checks.length} checks)`
      : `RELEASE PREFLIGHT FAILED (${report.failures} failure(s))`
  );
  return lines.join("\n");
}

function printUsage() {
  console.log(
    [
      "GraphFlow release preflight (read-only; never publishes, never uses credentials).",
      "",
      "Usage: node scripts/release-preflight.mjs [--fast] [--json] [--with-tests] [--with-package]",
      "",
      "  --fast          static checks only (wins over --with-tests/--with-package)",
      "  --json          machine-readable JSON report on stdout",
      "  --with-tests    also run `npm test`",
      "  --with-package  also run `npm pack --dry-run --json` (+ local `vsce package` if available)",
      "  --help          show this help",
    ].join("\n")
  );
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`release-preflight: ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    return 2;
  }
  if (options.help) {
    printUsage();
    return 0;
  }
  const report = runPreflight(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  return report.ok ? 0 : 1;
}

const ENTRY_PATH = process.argv[1] ? resolve(process.argv[1]) : "";
const IS_ENTRY = ENTRY_PATH === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  process.exitCode = main(process.argv.slice(2));
}
