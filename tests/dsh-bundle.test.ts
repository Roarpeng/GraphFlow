/**
 * GraphFlow — DSH configuration bundle tests (`tests/dsh-bundle.test.ts`).
 *
 * Validates the configuration-only DSH bundle in `packages/graphflow-dsh`
 * against the real DSH bundle manifest shape (verified from the shipped
 * `cordis-plugin-development` skill references and installed bundles), checks
 * the Cordis patch, the bundled skill, the version coupling with the root
 * package, and the README capability matrix (`MCP ✅ · Skill ✅ · Rules ❌ ·
 * Hooks ❌` — no false hook claim for DSH).
 *
 * The installer helper is exercised end-to-end with temp directories only:
 * `--print`, `--check`, `--stage`, plus direct validation of tampered copies.
 * No network, no real DSH profile, no package manager.
 *
 * Standalone: `npx tsx tests/dsh-bundle.test.ts`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");
const bundleDir = join(repoRoot, "packages", "graphflow-dsh");
const scriptPath = join(repoRoot, "scripts", "install-dsh-bundle.mjs");

const failures: string[] = [];
let checks = 0;

function check(name: string, fn: () => void | Promise<void>): void {
  checks += 1;
  try {
    const result = fn();
    if (result instanceof Promise) {
      (result as Promise<void>).catch((error) => {
        failures.push(name);
        console.error(`FAIL ${name}`);
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      });
      return;
    }
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
}

function runScript(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
}

interface TempBundleCopy {
  root: string;
  dir: string;
}

function copyBundleToTemp(): TempBundleCopy {
  const root = mkdtempSync(join(tmpdir(), "gf-dsh-bundle-copy-"));
  const dir = join(root, "bundle");
  cpSync(bundleDir, dir, { recursive: true });
  return { root, dir };
}

function failNames(result: { checks: Array<{ name: string; ok: boolean }> }): string[] {
  return result.checks.filter((item) => !item.ok).map((item) => item.name);
}

/**
 * Replace once while failing loudly when nothing changed. A silent no-op is how
 * line-ending drift (LF checkout here vs CRLF on Windows CI) turns a tamper
 * test into a false positive.
 */
function replaceOnce(content: string, search: string | RegExp, replacement: string, label: string): string {
  const next = content.replace(search, replacement);
  assert.notEqual(next, content, `${label}: tamper replacement was a no-op (line-ending drift?)`);
  return next;
}

/** Regex that removes one complete YAML line regardless of CRLF/LF endings. */
const YAML_LINE_PATTERN = (key: string): RegExp =>
  new RegExp(`^[ \\t]*${key}:[^\\r\\n]*(?:\\r?\\n)?`, "m");

const TEXT_FILE_EXTENSIONS = new Set([".json", ".yml", ".yaml", ".md", ".svg", ".txt"]);

/**
 * Normalize every text file in a copied bundle to CRLF, reproducing the
 * `core.autocrlf=true` Windows CI checkout. Returns the number of files whose
 * bytes changed (0 when the source worktree is already CRLF).
 */
function convertTextFilesToCrlf(rootDir: string): number {
  let converted = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!TEXT_FILE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const content = readFileSync(fullPath, "utf8");
      const crlf = content.replace(/\r?\n/g, "\r\n");
      if (crlf !== content) {
        writeFileSync(fullPath, crlf, "utf8");
        converted += 1;
      }
    }
  };
  walk(rootDir);
  return converted;
}

/** Assert a file really has CRLF line endings and no bare LF line break. */
function assertCrlf(filePath: string): void {
  const content = readFileSync(filePath, "utf8");
  assert.ok(content.includes("\r\n"), `${filePath} must contain CRLF line endings`);
  assert.ok(!/(^|[^\r])\n/.test(content), `${filePath} must not contain bare LF line breaks`);
}

async function run(): Promise<void> {
  const helper = (await import("../scripts/install-dsh-bundle.mjs")) as Record<string, any>;
  const validateBundle = helper.validateBundle as (
    dir: string,
    options?: { repoRoot?: string }
  ) => { ok: boolean; checks: Array<{ name: string; ok: boolean; warn?: string }>; manifest?: Record<string, any> };
  const formatValidation = helper.formatValidation as (result: unknown) => string;
  const stageBundle = helper.stageBundle as (dir?: string, options?: object) => { stageDir: string; validation: { ok: boolean } };
  const parseArgs = helper.parseArgs as (argv: string[]) => Record<string, any>;

  // -------------------------------------------------------------------------
  // 1. Manifest shape (verified against the DSH bundle references).
  // -------------------------------------------------------------------------
  check("bundle manifest matches the DSH configuration-only bundle shape", () => {
    const manifest = readJson(join(bundleDir, "package.json"));
    const rootManifest = readJson(join(repoRoot, "package.json"));

    assert.equal(manifest.name, "@roarpeng/graphflow-dsh");
    assert.equal(manifest.version, rootManifest.version, "bundle version mirrors root package version");
    assert.equal(manifest.type, "module");
    assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml", "dsh.bundle.patch is ./cordis.patch.yml (template/shipped shape)");
    assert.ok(manifest.icon, "display icon declared");
    for (const exportKey of ["./cordis.patch.yml", "./locale/*.json", "./icon"]) {
      assert.ok(exportKey in (manifest.exports ?? {}), `exports must include ${exportKey}`);
    }
    for (const file of ["cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "skills/graphflow/SKILL.md"]) {
      assert.ok((manifest.files ?? []).includes(file), `files must include ${file}`);
    }
    assert.ok(!("main" in manifest), "configuration-only bundle has no runtime entry point");
    assert.ok(!("." in (manifest.exports ?? {})), "configuration-only bundle exports no runtime module");
    assert.ok(!manifest.dependencies && !manifest.optionalDependencies && !manifest.peerDependencies, "no dependencies");
    for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
      assert.ok(!(manifest.scripts && lifecycle in manifest.scripts), `no ${lifecycle} script`);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Cordis patch: stdio MCP client, safe cwd, env pass-through.
  // -------------------------------------------------------------------------
  check("cordis.patch.yml inserts the graphflow MCP client with stdio/cwd/env", () => {
    const patchPath = join(bundleDir, "cordis.patch.yml");
    assert.ok(existsSync(patchPath), "cordis.patch.yml exists");
    const patch = readFileSync(patchPath, "utf8");

    assert.match(patch, /^# GraphFlow DSH bundle/m);
    assert.match(patch, /^\s*-\s*insert:\s*$/m);
    assert.match(patch, /^\s*-\s*id:\s*mcp-graphflow\s*$/m);
    assert.match(patch, /name:\s*'@deepseek-ai\/dsh-mcp-client'/);
    assert.match(patch, /serverName:\s*graphflow\s*$/m);
    assert.match(patch, /transport:\s*stdio\s*$/m);
    assert.match(patch, /command:\s*npx\s*$/m);
    assert.match(patch, /args:.*--package=@roarpeng\/graphflow/);
    assert.match(patch, /args:.*graphflow-mcp/);
    assert.match(patch, /cwd:.*GRAPHFLOW_WORKSPACE_ROOT/);
    assert.match(patch, /GRAPHFLOW_WORKSPACE_ROOT:\s*!!js\s+process\.env\.GRAPHFLOW_WORKSPACE_ROOT/);
    assert.match(patch, /GRAPHFLOW_MCP_STDIO:\s*'1'/);
    assert.match(patch, /GRAPHFLOW_LOG_JSON:\s*'1'/);
    assert.match(patch, /failOnStartupError:\s*false\s*$/m);
    assert.ok(!patch.includes("\t"), "YAML uses spaces, never tabs");
    assert.ok(!/!!js\s+process\.cwd\(\)\s*$/m.test(patch), "no bare legacy process.cwd() cwd");
    assert.ok(!patch.includes("mcp.json"), "the patch is Cordis YAML, not an mcp.json registration");
  });

  // -------------------------------------------------------------------------
  // 3. Bundled skill: frontmatter + copy of the canonical skill.
  // -------------------------------------------------------------------------
  check("bundled skill has graphflow frontmatter and mirrors the canonical skill", () => {
    const bundleSkill = readFileSync(join(bundleDir, "skills", "graphflow", "SKILL.md"), "utf8");
    const rootSkill = readFileSync(join(repoRoot, "skills", "graphflow", "SKILL.md"), "utf8");
    const frontmatter = bundleSkill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, "SKILL.md starts with YAML frontmatter");
    assert.match(frontmatter![1], /^name:\s*graphflow\s*$/m);
    assert.match(frontmatter![1], /^description:\s*\S/m);
    assert.equal(
      bundleSkill.replace(/\r\n/g, "\n"),
      rootSkill.replace(/\r\n/g, "\n"),
      "bundled skill is a copy of skills/graphflow/SKILL.md (line endings ignored)"
    );
  });

  // -------------------------------------------------------------------------
  // 4. Capability matrix is honest about DSH hooks/rules.
  // -------------------------------------------------------------------------
  check("README capability matrix claims MCP/Skill and no DSH hooks or rules", () => {
    const readme = readFileSync(join(bundleDir, "README.md"), "utf8");
    assert.ok(readme.includes("MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌"), "summary matrix line");
    assert.match(readme, /\|\s*MCP tools\s*\|\s*✅\s*\|/);
    assert.match(readme, /\|\s*Skill\s*\|\s*✅\s*\|/);
    assert.match(readme, /\|\s*Rules \/ instructions\s*\|\s*❌\s*\|/);
    assert.match(readme, /\|\s*Host hooks\s*\|\s*❌\s*\|/);
    assert.ok(!/\bhooks?\b[^\n|]*\|\s*✅/i.test(readme), "no matrix row claims hooks are available");
    assert.ok(!/DSH[^\n]*\bhooks?\b[^\n]*✅/i.test(readme), "no prose claims DSH hooks are available");
    assert.ok(readme.includes("install_bundle") && readme.includes("remove_bundle"), "install/uninstall instructions present");
  });

  // -------------------------------------------------------------------------
  // 5. validateBundle on the real bundle: every check passes.
  // -------------------------------------------------------------------------
  check("validateBundle passes on the repository bundle", () => {
    const result = validateBundle(bundleDir, { repoRoot });
    assert.equal(result.ok, true, formatValidation(result));
    assert.ok(result.checks.length >= 45, `expected the full check suite, got ${result.checks.length}`);
    assert.deepEqual(failNames(result), []);
    assert.ok(!result.checks.some((item) => item.warn), "no drift warnings in the committed bundle");
    assert.ok(result.manifest && result.manifest.name === "@roarpeng/graphflow-dsh");
  });

  // -------------------------------------------------------------------------
  // 6. CLI --check.
  // -------------------------------------------------------------------------
  check("install-dsh-bundle.mjs --check exits 0 with PASS output", () => {
    const result = runScript(["--check"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /RESULT: PASS \(\d+ checks\)/);
    assert.match(result.stdout, /PASS version-matches-root/);
    assert.match(result.stdout, /PASS readme-hooks-no/);
  });

  // -------------------------------------------------------------------------
  // 7. CLI --print prints the exact plugin_manager spec.
  // -------------------------------------------------------------------------
  check("install-dsh-bundle.mjs --print prints the plugin_manager install spec", () => {
    const result = runScript(["--print"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes("action: install_bundle"), "install action printed");
    assert.ok(result.stdout.includes("action: remove_bundle"), "uninstall action printed");
    assert.ok(result.stdout.includes("@roarpeng/graphflow-dsh"), "bundle package name printed");
    assert.ok(result.stdout.includes(bundleDir), "absolute bundle target printed");
    const jsonLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("JSON: "));
    assert.ok(jsonLine, "machine-readable JSON spec line printed");
    const spec = JSON.parse(jsonLine!.slice("JSON: ".length));
    assert.equal(spec.action, "install_bundle");
    assert.equal(resolve(spec.target), bundleDir);
  });

  // -------------------------------------------------------------------------
  // 8. CLI --stage: explicit dir, repeat overwrite, refusal, default dir.
  // -------------------------------------------------------------------------
  check("install-dsh-bundle.mjs --stage copies+validates (explicit dir, repeat, refusal)", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-dsh-stage-test-"));
    try {
      const stageDir = join(root, "staged");
      const first = runScript(["--stage", stageDir]);
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.ok(first.stdout.includes(`STAGED ${stageDir}`), "reports the staged directory");
      for (const relativePath of [
        "package.json",
        "cordis.patch.yml",
        "icon.svg",
        "README.md",
        "locale/en.json",
        "locale/zh.json",
        "skills/graphflow/SKILL.md",
        ".graphflow-dsh-stage.json",
      ]) {
        assert.ok(existsSync(join(stageDir, ...relativePath.split("/"))), `staged ${relativePath}`);
      }
      const stagedValidation = validateBundle(stageDir, { repoRoot });
      assert.equal(stagedValidation.ok, true, formatValidation(stagedValidation));

      // Re-staging our own marker directory is allowed and idempotent.
      const second = runScript(["--stage", stageDir]);
      assert.equal(second.status, 0, second.stderr || second.stdout);

      // A non-empty directory this tool did not stage is refused.
      const foreignDir = join(root, "foreign");
      mkdirSync(foreignDir, { recursive: true });
      writeFileSync(join(foreignDir, "user-file.txt"), "keep me\n", "utf8");
      const refused = runScript(["--stage", foreignDir]);
      assert.equal(refused.status, 1, "must refuse to overwrite a foreign non-empty dir");
      assert.match(`${refused.stdout}${refused.stderr}`, /refusing to overwrite non-empty non-staging directory/);
      assert.equal(readFileSync(join(foreignDir, "user-file.txt"), "utf8"), "keep me\n", "foreign content untouched");

      // Default staging path is relative to the invocation cwd.
      const cwdDir = join(root, "cwd");
      mkdirSync(cwdDir, { recursive: true });
      const defaultStage = runScript(["--stage"], cwdDir);
      assert.equal(defaultStage.status, 0, defaultStage.stderr || defaultStage.stdout);
      const defaultStageDir = join(cwdDir, ".graphflow", "dsh-bundle");
      assert.ok(existsSync(join(defaultStageDir, "package.json")), "default .graphflow/dsh-bundle staged");
      assert.ok(existsSync(join(defaultStageDir, ".graphflow-dsh-stage.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 9. Direct stageBundle guards.
  // -------------------------------------------------------------------------
  check("stageBundle refuses unsafe targets", () => {
    assert.throws(() => stageBundle(bundleDir, { repoRoot }), /refusing to stage over the source bundle/);
    assert.throws(() => stageBundle(repoRoot, { repoRoot }), /refusing to stage over the repository root/);
  });

  // -------------------------------------------------------------------------
  // 10. Tampered copies are rejected with specific failed checks.
  //     Every tamper runs against an LF copy and a CRLF copy (the Windows CI
  //     `core.autocrlf=true` checkout shape) so line-ending drift can never
  //     turn a tamper into a silent no-op again.
  // -------------------------------------------------------------------------
  check("validation rejects tampered LF and CRLF copies with specific failed checks", () => {
    const cases: Array<{ label: string; expectedCheck: string; tamper: (dir: string) => void }> = [
      {
        label: "version mismatch",
        expectedCheck: "version-matches-root",
        tamper: (dir) => {
          const manifest = readJson(join(dir, "package.json"));
          manifest.version = "0.0.0-tampered";
          writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        },
      },
      {
        label: "patch without serverName",
        expectedCheck: "patch-server-name",
        tamper: (dir) => {
          const patchPath = join(dir, "cordis.patch.yml");
          const stripped = replaceOnce(
            readFileSync(patchPath, "utf8"),
            YAML_LINE_PATTERN("serverName"),
            "",
            "remove serverName from cordis.patch.yml"
          );
          writeFileSync(patchPath, stripped, "utf8");
        },
      },
      {
        label: "missing skill",
        expectedCheck: "skill-file",
        tamper: (dir) => rmSync(join(dir, "skills", "graphflow", "SKILL.md"), { force: true }),
      },
      {
        label: "false hook claim",
        expectedCheck: "readme-hooks-no",
        tamper: (dir) => {
          const readmePath = join(dir, "README.md");
          writeFileSync(
            readmePath,
            replaceOnce(
              readFileSync(readmePath, "utf8"),
              "| Host hooks | ❌ |",
              "| Host hooks | ✅ |",
              "flip the Host hooks matrix row"
            ),
            "utf8"
          );
        },
      },
      {
        label: "runtime dependency",
        expectedCheck: "no-runtime-dependencies",
        tamper: (dir) => {
          const manifest = readJson(join(dir, "package.json"));
          manifest.dependencies = { "some-package": "1.0.0" };
          writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        },
      },
      {
        label: "wrong dsh.bundle.patch pointer",
        expectedCheck: "dsh-bundle-patch",
        tamper: (dir) => {
          const manifest = readJson(join(dir, "package.json"));
          manifest.dsh.bundle.patch = "cordis.patch.yml";
          writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        },
      },
    ];

    // "as-checked-out" is LF on Linux/macOS and CRLF on Windows CI; the forced
    // CRLF run guarantees the CRLF path is exercised on every platform.
    for (const eol of ["as-checked-out", "forced-crlf"] as const) {
      for (const testCase of cases) {
        const copy = copyBundleToTemp();
        try {
          if (eol === "forced-crlf") {
            convertTextFilesToCrlf(copy.dir);
            assertCrlf(join(copy.dir, "cordis.patch.yml"));
            assertCrlf(join(copy.dir, "README.md"));
            const baseline = validateBundle(copy.dir, { repoRoot });
            assert.equal(baseline.ok, true, `CRLF copy must validate before tampering: ${formatValidation(baseline)}`);
          }
          testCase.tamper(copy.dir);
          const result = validateBundle(copy.dir, { repoRoot });
          assert.equal(result.ok, false, `${eol} ${testCase.label} must fail validation`);
          assert.ok(
            failNames(result).includes(testCase.expectedCheck),
            `${eol} ${testCase.label}: expected failed check ${testCase.expectedCheck}, got ${failNames(result).join(", ")}`
          );
        } finally {
          rmSync(copy.root, { recursive: true, force: true });
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // 10b. CRLF audit: the validator and --stage keep working on a CRLF
  //      checkout, and the tamper helper removes the line on CRLF too.
  // -------------------------------------------------------------------------
  check("validator and staging stay CRLF-safe (Windows CI parity)", () => {
    const copy = copyBundleToTemp();
    const stageRoot = mkdtempSync(join(tmpdir(), "gf-dsh-stage-crlf-"));
    try {
      convertTextFilesToCrlf(copy.dir);
      assertCrlf(join(copy.dir, "cordis.patch.yml"));
      assertCrlf(join(copy.dir, "README.md"));
      assertCrlf(join(copy.dir, "skills", "graphflow", "SKILL.md"));
      const crlfValidation = validateBundle(copy.dir, { repoRoot });
      assert.equal(crlfValidation.ok, true, formatValidation(crlfValidation));

      const staged = stageBundle(join(stageRoot, "staged-crlf"), { repoRoot, bundleDir: copy.dir });
      assert.equal(staged.validation.ok, true);
      const stagedPatchPath = join(staged.stageDir, "cordis.patch.yml");
      const stagedPatch = readFileSync(stagedPatchPath, "utf8");
      assert.match(stagedPatch, /serverName:\s*graphflow\s*$/m, "staged CRLF patch is readable by the validator");
      if (stagedPatch.includes("\r\n")) {
        assertCrlf(stagedPatchPath);
      }

      const stripped = replaceOnce(
        stagedPatch,
        YAML_LINE_PATTERN("serverName"),
        "",
        "remove serverName from a CRLF patch"
      );
      assert.ok(!/serverName:\s*graphflow\s*$/m.test(stripped), "serverName line is really gone");
      writeFileSync(stagedPatchPath, stripped, "utf8");
      const broken = validateBundle(staged.stageDir, { repoRoot });
      assert.equal(broken.ok, false, "tampered CRLF patch must fail validation");
      assert.ok(
        failNames(broken).includes("patch-server-name"),
        `expected patch-server-name failure, got ${failNames(broken).join(", ")}`
      );
    } finally {
      rmSync(copy.root, { recursive: true, force: true });
      rmSync(stageRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 11. The patch's `!!js` cwd expression is valid JS with the documented
  //     Loader evaluation scope (`with (ctx) { return eval(expr) }`): env pin
  //     wins, then the context's working directory, then process.cwd().
  // -------------------------------------------------------------------------
  check("patch cwd !!js expression evaluates with the Loader scope and env override", () => {
    const patch = readFileSync(join(bundleDir, "cordis.patch.yml"), "utf8");
    const cwdLine = patch.split(/\r?\n/).find((line) => line.trimStart().startsWith("cwd:"));
    assert.ok(cwdLine, "cwd line present in the patch");
    const markerIndex = cwdLine!.indexOf("!!js");
    assert.ok(markerIndex >= 0, "cwd uses a !!js Loader expression");
    const expression = cwdLine!.slice(markerIndex + "!!js".length).trim();
    // Same evaluation shape as @deepseek-ai/cordis-plugin-loader config/utils.ts.
    const evaluate = new Function("ctx", "expr", "with (ctx) { return eval(expr) }") as (
      ctx: object,
      expr: string
    ) => unknown;
    const savedWorkspaceRoot = process.env.GRAPHFLOW_WORKSPACE_ROOT;
    try {
      delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
      assert.equal(
        evaluate({ get: () => ({ defaultDirectory: "C:/dsh-default-workspace" }) }, expression),
        "C:/dsh-default-workspace",
        "falls back to the DSH working directory when the env var is unset"
      );
      process.env.GRAPHFLOW_WORKSPACE_ROOT = "C:/my-graphflow-project";
      assert.equal(
        evaluate({ get: () => ({ defaultDirectory: "C:/dsh-default-workspace" }) }, expression),
        "C:/my-graphflow-project",
        "GRAPHFLOW_WORKSPACE_ROOT pins the cwd"
      );
    } finally {
      if (savedWorkspaceRoot === undefined) delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
      else process.env.GRAPHFLOW_WORKSPACE_ROOT = savedWorkspaceRoot;
    }
  });

  // -------------------------------------------------------------------------
  // 12. Argument parser.
  // -------------------------------------------------------------------------
  check("parseArgs handles --print/--check/--stage forms", () => {
    assert.deepEqual(parseArgs(["--print"]), {
      help: false,
      print: true,
      check: false,
      stage: false,
      stageDir: undefined,
      unknown: [],
    });
    const spaced = parseArgs(["--stage", "out/dir"]);
    assert.equal(spaced.stage, true);
    assert.equal(spaced.stageDir, "out/dir");
    const equals = parseArgs(["--stage=custom-dir", "--check"]);
    assert.equal(equals.stage, true);
    assert.equal(equals.stageDir, "custom-dir");
    assert.equal(equals.check, true);
    const mixed = parseArgs(["--print", "--stage"]);
    assert.equal(mixed.print, true);
    assert.equal(mixed.stage, true);
    assert.equal(mixed.stageDir, undefined);
    assert.deepEqual(parseArgs(["--bogus"]).unknown, ["--bogus"]);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${checks} DSH-BUNDLE CHECK(S) FAILED:`);
    for (const name of failures) console.error(`  - ${name}`);
    process.exit(1);
  }
  console.log(`\nALL ${checks} DSH-BUNDLE CHECKS PASSED`);
}

run().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
