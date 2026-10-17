#!/usr/bin/env node
/**
 * GraphFlow DSH bundle helper (`scripts/install-dsh-bundle.mjs`).
 *
 * Self-contained (Node built-ins only), offline, and non-destructive: it never
 * touches a real DSH profile, never runs package managers, and never installs
 * anything. It validates the configuration-only bundle in
 * `packages/graphflow-dsh`, prints the exact `plugin_manager` install spec, and
 * stages a copy for distribution/inspection.
 *
 * Usage:
 *   node scripts/install-dsh-bundle.mjs --print
 *   node scripts/install-dsh-bundle.mjs --check
 *   node scripts/install-dsh-bundle.mjs --stage [<dir>]   (default .graphflow/dsh-bundle)
 *   node scripts/install-dsh-bundle.mjs --help
 *
 * Exit code: 0 on success, 1 on any failed validation or invalid invocation.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE_PACKAGE_NAME = "@roarpeng/graphflow-dsh";
export const ROOT_PACKAGE_NAME = "@roarpeng/graphflow";
export const BUNDLE_RELATIVE_DIR = join("packages", "graphflow-dsh");
export const DEFAULT_STAGE_RELATIVE_DIR = join(".graphflow", "dsh-bundle");
export const STAGE_MARKER = ".graphflow-dsh-stage.json";
export const DSH_PATCH_RELATIVE = "cordis.patch.yml";
export const DSH_SKILL_RELATIVE = join("skills", "graphflow", "SKILL.md");

const MAX_ICON_BYTES = 256 * 1024;
const SKILL_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
];

/** Absolute path of this script. */
export function scriptPath() {
  return fileURLToPath(import.meta.url);
}

/** Repository root (the parent of `scripts/`). */
export function resolveRepoRoot() {
  return dirname(dirname(scriptPath()));
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function isInsideOrEqual(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Compare text files while ignoring CRLF/LF differences (git checkout policy). */
function normalizedText(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Validate the configuration-only bundle.
 * @param {string} bundleDir Absolute (or resolvable) bundle directory.
 * @param {{ repoRoot?: string }} [options]
 * @returns {{ ok: boolean, checks: Array<{name: string, ok: boolean, detail?: string, warn?: string}>, bundleDir: string, repoRoot: string, manifest?: any }}
 */
export function validateBundle(bundleDir, options = {}) {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot();
  const dir = resolve(bundleDir);
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  };

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    add("bundle-directory", false, `missing directory: ${dir}`);
    return { ok: false, checks, bundleDir: dir, repoRoot };
  }
  add("bundle-directory", true, dir);

  // --- Manifest -----------------------------------------------------------
  const manifestPath = join(dir, "package.json");
  let manifest;
  if (!existsSync(manifestPath)) {
    add("manifest-json", false, `missing ${manifestPath}`);
    return { ok: false, checks, bundleDir: dir, repoRoot };
  }
  try {
    manifest = readJsonFile(manifestPath);
    add("manifest-json", true);
  } catch (error) {
    add("manifest-json", false, error instanceof Error ? error.message : String(error));
    return { ok: false, checks, bundleDir: dir, repoRoot };
  }

  add("manifest-name", manifest.name === BUNDLE_PACKAGE_NAME, `expected ${BUNDLE_PACKAGE_NAME}, got ${manifest.name}`);

  const rootManifestPath = join(repoRoot, "package.json");
  let rootVersion;
  if (!existsSync(rootManifestPath)) {
    add("root-package", false, `missing ${rootManifestPath}`);
  } else {
    try {
      const rootManifest = readJsonFile(rootManifestPath);
      rootVersion = rootManifest.version;
      add("root-package", rootManifest.name === ROOT_PACKAGE_NAME, `root package ${rootManifest.name}@${rootManifest.version}`);
    } catch (error) {
      add("root-package", false, error instanceof Error ? error.message : String(error));
    }
  }
  add(
    "version-matches-root",
    typeof manifest.version === "string" && manifest.version === rootVersion,
    `bundle ${manifest.version} vs root ${rootVersion}`
  );
  add("bundle-type-module", manifest.type === "module", `expected "type": "module"`);

  const patchPointer = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch;
  add(
    "dsh-bundle-patch",
    patchPointer === "./cordis.patch.yml",
    `expected "dsh.bundle.patch": "./cordis.patch.yml", got ${JSON.stringify(patchPointer)}`
  );

  const exportsMap = manifest.exports && typeof manifest.exports === "object" ? manifest.exports : {};
  for (const exportKey of ["./cordis.patch.yml", "./locale/*.json", "./icon"]) {
    add(`exports:${exportKey}`, Object.prototype.hasOwnProperty.call(exportsMap, exportKey));
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const requiredFile of ["cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "skills/graphflow/SKILL.md"]) {
    add(`files:${requiredFile}`, files.includes(requiredFile));
  }

  // Configuration-only: no runtime code, dependencies, or install scripts.
  add(
    "no-runtime-dependencies",
    !manifest.dependencies && !manifest.optionalDependencies && !manifest.peerDependencies
  );
  const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  add(
    "no-lifecycle-scripts",
    !SKILL_LIFECYCLE_SCRIPTS.some((script) => Object.prototype.hasOwnProperty.call(scripts, script))
  );
  add("configuration-only", !("main" in manifest) && !Object.prototype.hasOwnProperty.call(exportsMap, "."));

  // --- Patch --------------------------------------------------------------
  const patchPath = join(dir, DSH_PATCH_RELATIVE);
  if (!existsSync(patchPath)) {
    add("patch-file", false, `missing ${patchPath}`);
  } else {
    add("patch-file", true, patchPath);
    const patch = readFileSync(patchPath, "utf8");
    const patchChecks = [
      ["patch-insert", /^\s*-\s*insert:\s*$/m, "a top-level `- insert:` row"],
      ["patch-row-id", /^\s*-\s*id:\s*mcp-graphflow\s*$/m, "`- id: mcp-graphflow`"],
      ["patch-plugin", /name:\s*'@deepseek-ai\/dsh-mcp-client'/, "@deepseek-ai/dsh-mcp-client plugin row"],
      ["patch-server-name", /serverName:\s*graphflow\s*$/m, "`serverName: graphflow`"],
      ["patch-transport", /transport:\s*stdio\s*$/m, "`transport: stdio`"],
      ["patch-command", /command:\s*npx\s*$/m, "`command: npx`"],
      ["patch-args-package", /args:.*--package=@roarpeng\/graphflow/, "`--package=@roarpeng/graphflow` args"],
      ["patch-args-entry", /args:.*graphflow-mcp/, "`graphflow-mcp` entrypoint"],
      ["patch-cwd", /cwd:.*GRAPHFLOW_WORKSPACE_ROOT/, "cwd honoring GRAPHFLOW_WORKSPACE_ROOT"],
      ["patch-workspace-env", /GRAPHFLOW_WORKSPACE_ROOT:\s*!!js\s+process\.env\.GRAPHFLOW_WORKSPACE_ROOT/, "GRAPHFLOW_WORKSPACE_ROOT env pass-through"],
      ["patch-mcp-env", /GRAPHFLOW_MCP_STDIO:\s*'1'/, "legacy GRAPHFLOW_MCP_STDIO env"],
      ["patch-log-env", /GRAPHFLOW_LOG_JSON:\s*'1'/, "legacy GRAPHFLOW_LOG_JSON env"],
      ["patch-fail-on-startup", /failOnStartupError:\s*false\s*$/m, "`failOnStartupError: false`"],
    ];
    for (const [name, pattern, description] of patchChecks) {
      add(name, pattern.test(patch), description);
    }
    add("patch-no-tabs", !patch.includes("\t"), "YAML must not contain tab indentation");
    add(
      "patch-no-bare-process-cwd",
      !/!!js\s+process\.cwd\(\)\s*$/m.test(patch),
      "cwd must prefer GRAPHFLOW_WORKSPACE_ROOT over a bare process.cwd()"
    );
  }

  // --- Skill --------------------------------------------------------------
  const skillPath = join(dir, DSH_SKILL_RELATIVE);
  if (!existsSync(skillPath)) {
    add("skill-file", false, `missing ${skillPath}`);
  } else {
    add("skill-file", true, skillPath);
    const skill = readFileSync(skillPath, "utf8");
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    add("skill-frontmatter", Boolean(frontmatter), "YAML frontmatter block");
    add("skill-name", frontmatter ? /^name:\s*graphflow\s*$/m.test(frontmatter[1]) : false, "`name: graphflow`");
    add(
      "skill-description",
      frontmatter ? /^description:\s*\S/m.test(frontmatter[1]) : false,
      "non-empty description"
    );
    const rootSkillPath = join(repoRoot, "skills", "graphflow", "SKILL.md");
    if (existsSync(rootSkillPath)) {
      const inSync = normalizedText(readFileSync(rootSkillPath, "utf8")) === normalizedText(skill);
      const check = { name: "skill-copy-sync", ok: true };
      if (!inSync) {
        check.warn =
          "bundle skill differs from skills/graphflow/SKILL.md; run `node scripts/install-dsh-bundle.mjs --stage` to refresh the staged copy";
      }
      checks.push(check);
    }
  }

  // --- Display metadata and icon -----------------------------------------
  for (const locale of ["en", "zh"]) {
    const localePath = join(dir, "locale", `${locale}.json`);
    if (!existsSync(localePath)) {
      add(`locale-${locale}`, false, `missing ${localePath}`);
      continue;
    }
    try {
      const localeData = readJsonFile(localePath);
      const meta = localeData && localeData.meta;
      add(
        `locale-${locale}`,
        Boolean(meta && typeof meta.title === "string" && meta.title.trim() && typeof meta.description === "string" && meta.description.trim()),
        "meta.title/meta.description"
      );
    } catch (error) {
      add(`locale-${locale}`, false, error instanceof Error ? error.message : String(error));
    }
  }

  const iconPath = join(dir, "icon.svg");
  if (!existsSync(iconPath)) {
    add("icon-file", false, `missing ${iconPath}`);
  } else {
    const icon = readFileSync(iconPath);
    add("icon-file", true, iconPath);
    add("icon-svg", icon.subarray(0, 512).toString("utf8").trimStart().startsWith("<svg"), "icon.svg starts with <svg");
    add("icon-size", icon.length > 0 && icon.length <= MAX_ICON_BYTES, `${icon.length} bytes (max ${MAX_ICON_BYTES})`);
  }

  // --- README capability matrix ------------------------------------------
  const readmePath = join(dir, "README.md");
  if (!existsSync(readmePath)) {
    add("readme-file", false, `missing ${readmePath}`);
  } else {
    add("readme-file", true, readmePath);
    const readme = readFileSync(readmePath, "utf8");
    add("readme-mcp-yes", /\|\s*MCP tools\s*\|\s*✅\s*\|/.test(readme), "matrix row: MCP tools ✅");
    add("readme-skill-yes", /\|\s*Skill\s*\|\s*✅\s*\|/.test(readme), "matrix row: Skill ✅");
    add("readme-rules-no", /\|\s*Rules \/ instructions\s*\|\s*❌\s*\|/.test(readme), "matrix row: Rules / instructions ❌");
    add("readme-hooks-no", /\|\s*Host hooks\s*\|\s*❌\s*\|/.test(readme), "matrix row: Host hooks ❌");
    add(
      "readme-summary-matrix",
      readme.includes("MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌"),
      "summary line: MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌"
    );
    add(
      "readme-no-false-hook-claim",
      !/\bhooks?\b[^\n|]*\|\s*✅/i.test(readme) && !/DSH[^\n]*\bhooks?\b[^\n]*✅/i.test(readme),
      "no matrix/line claims DSH hooks are available"
    );
    add(
      "readme-install-instructions",
      readme.includes("install_bundle") && readme.includes("remove_bundle"),
      "plugin_manager install and uninstall instructions"
    );
  }

  const ok = checks.every((check) => check.ok);
  return { ok, checks, bundleDir: dir, repoRoot, manifest, patchPath, skillPath, readmePath };
}

/** Human-readable validation output (PASS/FAIL lines plus a RESULT line). */
export function formatValidation(result) {
  const lines = result.checks.map((check) => {
    const status = check.ok ? "PASS" : "FAIL";
    const detail = check.detail ? ` (${check.detail})` : "";
    const warn = check.warn ? ` WARN: ${check.warn}` : "";
    return `${status} ${check.name}${detail}${warn}`;
  });
  if (result.ok) {
    lines.push(`RESULT: PASS (${result.checks.length} checks)`);
  } else {
    const failed = result.checks.filter((check) => !check.ok).length;
    lines.push(`RESULT: FAIL (${failed}/${result.checks.length} checks failed)`);
  }
  return lines.join("\n");
}

/**
 * Copy the bundle into a staging directory and validate the copy.
 * Refuses to overwrite a non-empty directory that this tool did not stage.
 * @param {string} stageDir Staging directory (defaults to the caller's `.graphflow/dsh-bundle`).
 * @param {{ repoRoot?: string, bundleDir?: string, refreshSkill?: boolean }} [options]
 */
export function stageBundle(stageDir = resolve(DEFAULT_STAGE_RELATIVE_DIR), options = {}) {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot();
  const bundleDir = options.bundleDir ? resolve(options.bundleDir) : join(repoRoot, BUNDLE_RELATIVE_DIR);
  const target = resolve(stageDir);

  if (!existsSync(bundleDir)) throw new Error(`source bundle is missing: ${bundleDir}`);
  if (target === resolve(bundleDir)) throw new Error(`refusing to stage over the source bundle: ${target}`);
  if (target === resolve(repoRoot)) throw new Error(`refusing to stage over the repository root: ${target}`);
  if (isInsideOrEqual(resolve(bundleDir), target)) {
    throw new Error(`refusing to stage over an ancestor of the source bundle: ${target}`);
  }

  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new Error(`stage target is not a directory: ${target}`);
    if (readdirSync(target).length > 0) {
      if (!existsSync(join(target, STAGE_MARKER))) {
        throw new Error(`refusing to overwrite non-empty non-staging directory: ${target}`);
      }
      rmSync(target, { recursive: true, force: true });
    }
  }
  mkdirSync(target, { recursive: true });
  cpSync(bundleDir, target, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return name !== "node_modules" && name !== ".git" && name !== ".graphflow";
    },
  });

  // Keep the staged skill byte-identical to the repository's canonical skill.
  const rootSkillPath = join(repoRoot, "skills", "graphflow", "SKILL.md");
  if (options.refreshSkill !== false && existsSync(rootSkillPath)) {
    const stagedSkillDir = dirname(join(target, DSH_SKILL_RELATIVE));
    mkdirSync(stagedSkillDir, { recursive: true });
    cpSync(rootSkillPath, join(target, DSH_SKILL_RELATIVE));
  }

  const validation = validateBundle(target, { repoRoot });
  if (!validation.ok) {
    throw new Error(`staged bundle failed validation:\n${formatValidation(validation)}`);
  }
  writeFileSync(
    join(target, STAGE_MARKER),
    `${JSON.stringify(
      {
        tool: "graphflow-dsh-bundle",
        source: bundleDir,
        version: validation.manifest ? validation.manifest.version : undefined,
        stagedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { stageDir: target, validation };
}

/** The exact spec to hand to `plugin_manager`. */
export function installSpec(options = {}) {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot();
  const bundleDir = join(repoRoot, BUNDLE_RELATIVE_DIR);
  return {
    action: "install_bundle",
    target: bundleDir,
    package: BUNDLE_PACKAGE_NAME,
    uninstall: { action: "remove_bundle", target: BUNDLE_PACKAGE_NAME },
  };
}

/** Human-readable install/uninstall instructions including the exact spec. */
export function printInstallSpec(options = {}) {
  const spec = installSpec(options);
  return [
    "GraphFlow DSH bundle install spec (plugin_manager requires danger-full-access or approval):",
    "  action: install_bundle",
    `  target: "${spec.target}"`,
    `  bundle: ${BUNDLE_PACKAGE_NAME}`,
    "",
    `JSON: ${JSON.stringify({ action: spec.action, target: spec.target })}`,
    "",
    "Uninstall:",
    "  action: remove_bundle",
    `  target: ${spec.uninstall.target}`,
    "",
    "Skill companion step: copy `skills/graphflow` from the bundle (or the staged copy) into",
    "<DSH_HOME>/skills/graphflow so DSH's user skill root discovers it.",
  ].join("\n");
}

/** Parse CLI arguments; unknown arguments are reported by the caller. */
export function parseArgs(argv) {
  const parsed = {
    help: false,
    print: false,
    check: false,
    stage: false,
    stageDir: undefined,
    unknown: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--print") parsed.print = true;
    else if (arg === "--check") parsed.check = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--stage") {
      parsed.stage = true;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        parsed.stageDir = next;
        index += 1;
      }
    } else if (arg.startsWith("--stage=")) {
      parsed.stage = true;
      parsed.stageDir = arg.slice("--stage=".length);
    } else {
      parsed.unknown.push(arg);
    }
  }
  return parsed;
}

export function printUsage() {
  console.log(
    [
      "GraphFlow DSH bundle helper (offline, non-destructive)",
      "",
      "Usage:",
      "  node scripts/install-dsh-bundle.mjs --print          Print the exact plugin_manager install/uninstall spec",
      "  node scripts/install-dsh-bundle.mjs --check          Validate manifest, patch, skill, version, capability matrix",
      `  node scripts/install-dsh-bundle.mjs --stage [<dir>]  Copy the bundle to a staging dir (default ${DEFAULT_STAGE_RELATIVE_DIR}) and validate it`,
      "  node scripts/install-dsh-bundle.mjs --help           Show this help",
      "",
      "This helper never touches a real DSH profile and never runs a package manager.",
    ].join("\n")
  );
}

/** CLI entry point. Returns a process exit code. */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.unknown.length > 0) {
    console.error(`Unknown argument(s): ${args.unknown.join(" ")}`);
    printUsage();
    return 1;
  }
  if (args.help || (!args.print && !args.check && !args.stage)) {
    printUsage();
    return 0;
  }
  if (args.print) {
    console.log(printInstallSpec());
    return 0;
  }
  if (args.check) {
    const result = validateBundle(resolve(join(resolveRepoRoot(), BUNDLE_RELATIVE_DIR)));
    console.log(formatValidation(result));
    return result.ok ? 0 : 1;
  }
  try {
    const result = stageBundle(args.stageDir === undefined ? resolve(DEFAULT_STAGE_RELATIVE_DIR) : resolve(args.stageDir));
    console.log(formatValidation(result.validation));
    console.log(`STAGED ${result.stageDir}`);
    return 0;
  } catch (error) {
    console.error(`STAGE FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === scriptPath()) {
  process.exitCode = await main();
}
