/**
 * Tests for `scripts/release-preflight.mjs`.
 *
 * Two layers:
 *  1. Pure helper unit tests against mkdtemp() fixture repos (version
 *     consistency, required files, workflow contracts, skill frontmatter,
 *     package metadata, npm-pack entry validation, argv parsing).
 *  2. A real integration run of the script against this repository in
 *     `--fast --json` mode (static checks only — no npm test/build/publish).
 *
 * Standalone: `npx tsx tests/release-preflight.test.ts`.
 * Also auto-discovered by `tests/run-all.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type PreflightModule = typeof import("../scripts/release-preflight.mjs");

const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "release-preflight.mjs");

const results: Array<{ name: string; ok: boolean }> = [];
const createdRoots: string[] = [];
let preflight: PreflightModule;

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`FAIL ${name}\n${detail}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

function assertThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

function writeFixtureFile(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

const CI_WORKFLOW = [
  "name: CI",
  "",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "  workflow_dispatch:",
  "",
  "jobs:",
  "  test:",
  "    strategy:",
  "      matrix:",
  "        os: [ubuntu-latest, windows-latest, macos-latest]",
  "        node-version: [20, 22]",
  "    runs-on: ${{ matrix.os }}",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          cache: npm",
  "      - run: npm ci",
  "      - run: npm run build",
  "      - run: npm test",
].join("\n");

const PUBLISH_NPM_WORKFLOW = [
  "name: Publish npm",
  "",
  "on:",
  "  push:",
  '    tags: ["v*"]',
  "  workflow_dispatch:",
  "",
  "permissions:",
  "  contents: read",
  "  id-token: write",
  "",
  "jobs:",
  "  publish:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm install --no-audit",
  "      - run: npm run build && npm test",
  "      - name: Publish",
  "        env:",
  "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
  "        run: npm publish --access public",
].join("\n");

const PUBLISH_MARKETPLACE_WORKFLOW = [
  "name: Publish Marketplace",
  "",
  "on:",
  "  push:",
  '    tags: ["v*"]',
  "  workflow_dispatch:",
  "",
  "jobs:",
  "  release:",
  "    steps:",
  "      - run: npx --yes @vscode/vsce package --no-dependencies",
  "      - run: gh release create v1.0.0",
  "  marketplace:",
  "    steps:",
  "      - run: vsce publish --no-dependencies",
  "  openvsx:",
  "    steps:",
  "      - run: npx --yes ovsx publish graphflow.vsix",
].join("\n");

function baseFixtureFiles(): Record<string, string> {
  const version = "9.9.9";
  const packageJson = {
    name: "@roarpeng/graphflow",
    version,
    main: "dist/index.js",
    types: "dist/index.d.ts",
    bin: { graphflow: "dist/cli.js", "graphflow-mcp": "dist/mcp-server.js" },
    files: ["dist", "skills", "mcp.json", "README.md", "README.zh.md", "LICENSE", "VSIX-INSTALL.md"],
    engines: { node: ">=18" },
    scripts: { prepublishOnly: "npm run build", build: "tsc -p tsconfig.json", test: "tsx tests/run-all.ts" },
  };
  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify(
      {
        name: "@roarpeng/graphflow",
        version,
        lockfileVersion: 3,
        packages: { "": { name: "@roarpeng/graphflow", version } },
      },
      null,
      2
    )}\n`,
    "vscode-extension/package.json": `${JSON.stringify(
      { name: "graphflow", publisher: "roarpeng", version },
      null,
      2
    )}\n`,
    "README.md": `# GraphFlow\n\n> **The Token-First Surgical Code Engine for AI Coding Agents (v${version})**\n`,
    "README.zh.md": `# GraphFlow\n\n> **面向 AI 编程 Agent 的省 Token 外科手术级代码引擎（v${version}）**\n`,
    "skills/graphflow/SKILL.md": "---\nname: graphflow\ndescription: Token-First Surgical Code Engine\n---\n\n# GraphFlow\n",
    "mcp.json": `${JSON.stringify(
      {
        mcpServers: {
          graphflow: {
            type: "stdio",
            command: "npx",
            args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
          },
        },
      },
      null,
      2
    )}\n`,
    LICENSE: "Apache License 2.0\n",
    "VSIX-INSTALL.md": "# VSIX installation\n",
    "dist/index.js": "module.exports = {};\n",
    "dist/index.d.ts": "export {};\n",
    "dist/mcp-server.js": "// mcp server\n",
    "dist/cli.js": "// cli\n",
    "dist/tree-sitter-engine.js": "// tree sitter\n",
    ".github/workflows/ci.yml": CI_WORKFLOW,
    ".github/workflows/publish-npm.yml": PUBLISH_NPM_WORKFLOW,
    ".github/workflows/publish-marketplace.yml": PUBLISH_MARKETPLACE_WORKFLOW,
  };
}

function makeFixture(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gf-preflight-"));
  createdRoots.push(root);
  const files = baseFixtureFiles();
  for (const [relPath, content] of Object.entries(overrides)) {
    if (content === null) delete files[relPath];
    else files[relPath] = content;
  }
  for (const [relPath, content] of Object.entries(files)) {
    writeFixtureFile(root, relPath, content);
  }
  return root;
}

function checkByName(checks: Array<{ name: string; ok: boolean; detail?: string }>, name: string) {
  const found = checks.find((item) => item.name === name);
  assert(found, `expected a check named "${name}"`);
  return found;
}

function testVersionConsistency(): void {
  check("version consistency passes when all 6 sources agree", () => {
    const root = makeFixture();
    const result = preflight.checkVersionConsistency(root);
    assertEqual(result.ok, true, `expected ok, got ${result.detail}`);
    assert(result.detail?.includes("9.9.9"), `detail should name the version: ${result.detail}`);
    assertEqual(preflight.collectVersionFacts(root).facts.length, 6, "fact count");
  });

  check("version consistency fails on a README tagline mismatch with clear diffs", () => {
    const root = makeFixture({
      "README.md": "# GraphFlow\n\n> **Engine (v0.0.1)**\n",
    });
    const result = preflight.checkVersionConsistency(root);
    assertEqual(result.ok, false, "mismatched tagline must fail");
    assert(result.detail?.includes("version mismatch"), `detail: ${result.detail}`);
    assert(result.detail?.includes("README.md tagline=0.0.1"), `detail: ${result.detail}`);
    assert(result.detail?.includes("package.json=9.9.9"), `detail: ${result.detail}`);
  });

  check("version consistency fails on a vscode-extension mismatch", () => {
    const root = makeFixture({
      "vscode-extension/package.json": `${JSON.stringify({ name: "graphflow", version: "8.8.8" }, null, 2)}\n`,
    });
    const result = preflight.checkVersionConsistency(root);
    assertEqual(result.ok, false, "mismatched VSIX version must fail");
    assert(result.detail?.includes("vscode-extension/package.json=8.8.8"), `detail: ${result.detail}`);
  });

  check("version consistency fails clearly when a versioned file is missing", () => {
    const root = makeFixture({ "README.md": null });
    const result = preflight.checkVersionConsistency(root);
    assertEqual(result.ok, false, "missing README must fail");
    assert(result.detail?.includes("README.md: missing"), `detail: ${result.detail}`);
  });
}

function testRequiredFiles(): void {
  check("required files pass on a complete fixture", () => {
    const result = preflight.checkRequiredFiles(makeFixture());
    assertEqual(result.ok, true, `detail: ${result.detail}`);
    assertEqual(preflight.REQUIRED_FILES.length, 13, "required file count");
  });

  check("required files fail on a missing dist artifact with a build hint", () => {
    const root = makeFixture({ "dist/cli.js": null });
    const result = preflight.checkRequiredFiles(root);
    assertEqual(result.ok, false, "missing dist/cli.js must fail");
    assert(result.detail?.includes("dist/cli.js"), `detail: ${result.detail}`);
    assert(result.detail?.includes("npm run build"), `detail must hint the build: ${result.detail}`);
    assert(!existsSync(join(root, "dist", "cli.js")), "fixture should really miss the file");
  });
}

function testWorkflowContracts(): void {
  check("workflow contracts pass on the fixture workflows", () => {
    const checks = preflight.checkWorkflows(makeFixture());
    assertEqual(checks.length, 3, "one check per workflow");
    for (const item of checks) {
      assertEqual(item.ok, true, `${item.name} should pass: ${item.detail}`);
    }
  });

  check("workflow contracts fail when a workflow file is missing", () => {
    const root = makeFixture({ ".github/workflows/publish-npm.yml": null });
    const checks = preflight.checkWorkflows(root);
    const npmCheck = checkByName(checks, "workflow-publish-npm");
    assertEqual(npmCheck.ok, false, "missing publish-npm.yml must fail");
    assert(npmCheck.detail?.includes("publish-npm.yml"), `detail: ${npmCheck.detail}`);
  });

  check("workflow contracts fail when key content is removed", () => {
    const root = makeFixture({
      ".github/workflows/ci.yml": CI_WORKFLOW.replace("      - run: npm ci\n", ""),
    });
    const ciCheck = checkByName(preflight.checkWorkflows(root), "workflow-ci");
    assertEqual(ciCheck.ok, false, "missing `npm ci` must fail the CI contract");
    assert(ciCheck.detail?.includes("missing expected content"), `detail: ${ciCheck.detail}`);
    assert(ciCheck.detail?.includes("npm ci"), `detail: ${ciCheck.detail}`);
  });

  check("workflow audits never rewrite the workflow files", () => {
    const root = makeFixture();
    const before = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    preflight.checkWorkflows(root);
    const after = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    assertEqual(after, before, "workflow content must be untouched");
  });
}

function testOtherStaticChecks(): void {
  check("mcp-config check accepts the stdio launcher and rejects a missing entry", () => {
    assertEqual(preflight.checkMcpConfig(makeFixture()).ok, true, "valid mcp.json should pass");
    const broken = makeFixture({ "mcp.json": `${JSON.stringify({ mcpServers: {} })}\n` });
    const result = preflight.checkMcpConfig(broken);
    assertEqual(result.ok, false, "missing graphflow entry must fail");
    assert(result.detail?.includes("graphflow"), `detail: ${result.detail}`);
  });

  check("skill-frontmatter check requires name/description", () => {
    assertEqual(preflight.checkSkillFrontmatter(makeFixture()).ok, true, "valid frontmatter");
    const broken = makeFixture({ "skills/graphflow/SKILL.md": "# No frontmatter\n" });
    const result = preflight.checkSkillFrontmatter(broken);
    assertEqual(result.ok, false, "missing frontmatter must fail");
    assert(result.detail?.includes("frontmatter"), `detail: ${result.detail}`);
  });

  check("package-metadata check validates main/types targets and publish hooks", () => {
    assertEqual(preflight.checkPackageMetadata(makeFixture()).ok, true, "valid package metadata");
    const root = makeFixture();
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    pkg.main = "dist/missing.js";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    const result = preflight.checkPackageMetadata(root);
    assertEqual(result.ok, false, "missing main target must fail");
    assert(result.detail?.includes("dist/missing.js"), `detail: ${result.detail}`);
  });
}

function testPackValidation(): void {
  function packEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: "@roarpeng/graphflow@9.9.9",
      version: "9.9.9",
      filename: "roarpeng-graphflow-9.9.9.tgz",
      size: 1000,
      unpackedSize: 50_000,
      files: preflight.REQUIRED_PACK_FILES.map((path) => ({ path, size: 100, mode: 420 })),
      ...overrides,
    };
  }

  check("npm-pack validation accepts a clean tarball listing", () => {
    const result = preflight.validatePackEntry(packEntry(), "9.9.9");
    assertEqual(result.ok, true, `detail: ${result.detail}`);
  });

  check("npm-pack validation rejects missing required files", () => {
    const entry = packEntry();
    entry.files = entry.files.filter((file) => file.path !== "dist/cli.js");
    const result = preflight.validatePackEntry(entry, "9.9.9");
    assertEqual(result.ok, false, "missing dist/cli.js must fail");
    assert(result.detail?.includes("dist/cli.js"), `detail: ${result.detail}`);
  });

  check("npm-pack validation rejects tests/source/scripts in the tarball", () => {
    const entry = packEntry();
    entry.files = [...entry.files, { path: "tests/leak.test.ts", size: 10, mode: 420 }];
    const result = preflight.validatePackEntry(entry, "9.9.9");
    assertEqual(result.ok, false, "tests/ must not ship");
    assert(result.detail?.includes("tests/leak.test.ts"), `detail: ${result.detail}`);
  });

  check("npm-pack validation rejects a version mismatch", () => {
    const result = preflight.validatePackEntry(
      packEntry({ version: "0.0.1", filename: "roarpeng-graphflow-0.0.1.tgz" }),
      "9.9.9"
    );
    assertEqual(result.ok, false, "version mismatch must fail");
    assert(result.detail?.includes("does not match"), `detail: ${result.detail}`);
  });
}

function testArgParsing(): void {
  check("parseArgs defaults to static mode", () => {
    const options = preflight.parseArgs([]);
    assertEqual(options.fast, false, "fast");
    assertEqual(options.json, false, "json");
    assertEqual(options.withTests, false, "withTests");
    assertEqual(options.withPackage, false, "withPackage");
  });

  check("--fast wins over --with-tests/--with-package", () => {
    const options = preflight.parseArgs(["--fast", "--with-tests", "--with-package", "--json"]);
    assertEqual(options.fast, true, "fast");
    assertEqual(options.json, true, "json");
    assertEqual(options.withTests, false, "--fast must disable npm test");
    assertEqual(options.withPackage, false, "--fast must disable packaging checks");
  });

  check("unknown flags are rejected", () => {
    assertThrows(() => preflight.parseArgs(["--publish"]), "unknown --publish flag must throw");
  });
}

function testRunPreflightAggregation(): void {
  check("runPreflight aggregates static fixture checks without subprocesses", () => {
    const root = makeFixture();
    const report = preflight.runPreflight({ rootDir: root, fast: true });
    assertEqual(report.ok, true, `expected pass, failures=${report.failures}`);
    assertEqual(report.mode, "fast", "mode");
    assertEqual(report.version, "9.9.9", "version");
    const names = report.checks.map((item) => item.name);
    for (const expected of [
      "version-consistency",
      "required-files",
      "mcp-config",
      "workflow-ci",
      "workflow-publish-npm",
      "workflow-publish-marketplace",
      "skill-frontmatter",
      "package-metadata",
    ]) {
      assert(names.includes(expected), `report must include ${expected}, got ${names.join(",")}`);
    }
    assert(!names.includes("npm-test"), "fast mode must not run npm test");
    assert(!names.includes("npm-pack"), "fast mode must not run npm pack");
  });

  check("runPreflight reports failures for a broken fixture", () => {
    const root = makeFixture({ "README.md": null, "dist/index.js": null });
    const report = preflight.runPreflight({ rootDir: root, fast: true });
    assertEqual(report.ok, false, "broken fixture must fail");
    assert(report.failures >= 2, `expected >=2 failures, got ${report.failures}`);
  });
}

function testRepositoryIntegration(): void {
  check("script --fast --json passes on this repository", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--fast", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    assertEqual(result.status, 0, `preflight exited ${result.status}: ${result.stderr}`);
    const stdout = (result.stdout ?? "").trim();
    assert(stdout.startsWith("{"), `--json must emit a single JSON object, got: ${stdout.slice(0, 200)}`);
    const report = JSON.parse(stdout) as {
      ok: boolean;
      version: string;
      mode: string;
      checks: Array<{ name: string; ok: boolean }>;
      failures: number;
    };
    assertEqual(report.ok, true, `expected ok report, failures=${report.failures}`);
    assertEqual(report.mode, "fast", "mode");
    assertEqual(report.failures, 0, "failures");
    const rootVersion = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
    ).version;
    assertEqual(report.version, rootVersion, "report version must match package.json");
    const names = report.checks.map((item) => item.name);
    for (const expected of [
      "version-consistency",
      "required-files",
      "package-metadata",
      "skill-frontmatter",
      "workflow-ci",
      "workflow-publish-npm",
      "workflow-publish-marketplace",
    ]) {
      assert(names.includes(expected), `report must include ${expected}, got ${names.join(",")}`);
    }
  });

  check("script --fast prints PASS lines and exits 0 on this repository", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--fast"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    assertEqual(result.status, 0, `preflight exited ${result.status}: ${result.stderr}`);
    const stdout = result.stdout ?? "";
    assert(stdout.includes("RELEASE PREFLIGHT PASSED"), `stdout:\n${stdout}`);
    assert(!stdout.includes("FAIL "), `no check may fail:\n${stdout}`);
  });
}

async function main(): Promise<void> {
  preflight = await import("../scripts/release-preflight.mjs");
  try {
    testVersionConsistency();
    testRequiredFiles();
    testWorkflowContracts();
    testOtherStaticChecks();
    testPackValidation();
    testArgParsing();
    testRunPreflightAggregation();
    testRepositoryIntegration();
  } finally {
    for (const root of createdRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} release-preflight checks passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("release-preflight test failed:", err);
  process.exit(1);
});
