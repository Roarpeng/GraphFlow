/**
 * DeepSeek Harness (dsh) installer — home-level cordis.patch.yml overlay.
 *
 * GraphFlow ships as a dsh bundle (`dsh.bundle` + `cordis.patch.yml`). Users can:
 *   dsh plugin --profile web add @roarpeng/graphflow
 *
 * Ownership rules (avoid unbootable harness):
 * 1. When `@roarpeng/graphflow` is installed in `profiles/<profile>`, the **bundle**
 *    owns MCP + glue. `graphflow install` clears any managed home overlay so Cordis
 *    does not hit `duplicate loader entry id: mcp-graphflow`.
 * 2. When the package is missing, `graphflow install` writes an **MCP-only** home
 *    overlay (npx graphflow-mcp). It never writes the glue row without the package —
 *    that caused `ERR_MODULE_NOT_FOUND` and blocked `dsh web`.
 *
 * Skills go to `$DSH_HOME/skills/graphflow/SKILL.md` via skill-installer targets;
 * the bundle glue also registers the skill at runtime so `dsh plugin add` is enough.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getHostAdapter } from "./host-adapter";

/** HostAdapter registry id for this installer slice. */
export const DSH_HOST_ADAPTER_ID = "deepseek-harness";

function dshAdapterDisplayName(): string {
  return getHostAdapter(DSH_HOST_ADAPTER_ID)?.displayName ?? "DeepSeek Harness";
}

export const DSH_HOME_ENV = "GRAPHFLOW_DSH_HOME";
export const DSH_MCP_ROW_ID = "mcp-graphflow";
export const DSH_GLUE_ROW_ID = "graphflow-dsh";
export const DSH_PACKAGE_NAME = "@roarpeng/graphflow";
export const DSH_GLUE_PACKAGE = "@roarpeng/graphflow/dsh";
export const DSH_DEFAULT_PROFILE = "web";
export const DSH_PATCH_BEGIN = "# GRAPHFLOW-DSH-BEGIN";
export const DSH_PATCH_END = "# GRAPHFLOW-DSH-END";

export interface DshHarnessPaths {
  dshHome: string;
  patchPath: string;
  skillsRoot: string;
  skillPath: string;
}

export interface DshHarnessStatus {
  agent: string;
  detected: boolean;
  installed: boolean;
  glueInstalled: boolean;
  packageInstalled: boolean;
  skillInstalled: boolean;
  dshHome: string;
  patchPath: string;
  skillPath: string;
  profileDir: string;
}

export interface DshHarnessInstallResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

export interface DshHarnessInstallOptions {
  dshHome?: string;
  /** Profile that must resolve `@roarpeng/graphflow` for glue (default: web). */
  profile?: string;
  /**
   * Force include/exclude the glue row in a home overlay.
   * Ignored when the package is present in the profile (home overlay is cleared).
   * Default when package missing: false (MCP-only).
   */
  includeGlue?: boolean;
  /**
   * Best-effort: run `npm install @roarpeng/graphflow --omit=optional` in the profile
   * and add it to `dsh.profile.bundles` when missing. Default: false.
   */
  ensurePackage?: boolean;
}

/** Resolve DeepSeek Harness home: GRAPHFLOW_DSH_HOME, else DSH_HOME, else ~/.dsh. */
export function resolveDshHome(override?: string): string {
  const explicit = override?.trim() || process.env[DSH_HOME_ENV]?.trim() || process.env.DSH_HOME?.trim();
  if (explicit) {
    return explicit;
  }
  return join(homedir(), ".dsh");
}

export function getDshHarnessPaths(dshHome = resolveDshHome()): DshHarnessPaths {
  const skillsRoot = join(dshHome, "skills");
  return {
    dshHome,
    patchPath: join(dshHome, "cordis.patch.yml"),
    skillsRoot,
    skillPath: join(skillsRoot, "graphflow", "SKILL.md"),
  };
}

export function getDshProfileDir(
  dshHome = resolveDshHome(),
  profile = DSH_DEFAULT_PROFILE
): string {
  return join(dshHome, "profiles", profile);
}

/** True when Cordis can resolve `@roarpeng/graphflow` from the given profile. */
export function isGraphFlowPackageInProfile(
  dshHome = resolveDshHome(),
  profile = DSH_DEFAULT_PROFILE
): boolean {
  return existsSync(
    join(getDshProfileDir(dshHome, profile), "node_modules", "@roarpeng", "graphflow", "package.json")
  );
}

export function isDshHarnessDetected(dshHome = resolveDshHome()): boolean {
  return existsSync(dshHome);
}

export interface BuildDshInsertPatchOptions {
  /** Include `@roarpeng/graphflow/dsh` glue row. Default true (matches repo cordis.patch.yml). */
  includeGlue?: boolean;
}

/**
 * The insert layer GraphFlow contributes as a dsh bundle.
 * Keep the full form (includeGlue: true) in sync with repo-root `cordis.patch.yml`.
 */
export function buildGraphFlowDshInsertPatch(options: BuildDshInsertPatchOptions = {}): string {
  const includeGlue = options.includeGlue !== false;
  const lines = [
    "- insert:",
    `    - id: ${DSH_MCP_ROW_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: graphflow",
    "        transport: stdio",
    "        command: npx",
    "        args:",
    "          - '-y'",
    `          - '--package=${DSH_PACKAGE_NAME}'`,
    "          - graphflow-mcp",
    "        env:",
    "          GRAPHFLOW_MCP_STDIO: '1'",
    "          GRAPHFLOW_LOG_JSON: '1'",
    "        cwd: !!js process.cwd()",
    "        failOnStartupError: false",
  ];
  if (includeGlue) {
    lines.push(`    - id: ${DSH_GLUE_ROW_ID}`, `      name: '${DSH_GLUE_PACKAGE}'`);
  }
  lines.push("");
  return lines.join("\n");
}

export function wrapDshManagedPatch(insertPatch: string = buildGraphFlowDshInsertPatch()): string {
  return `${DSH_PATCH_BEGIN}\n${insertPatch.trimEnd()}\n${DSH_PATCH_END}\n`;
}

export function patchContainsGraphFlowDsh(content: string): boolean {
  if (content.includes(DSH_PATCH_BEGIN) && content.includes(DSH_PATCH_END)) {
    return true;
  }
  return new RegExp(`^\\s*-\\s*id:\\s*${DSH_MCP_ROW_ID}\\s*$`, "m").test(content);
}

export function patchContainsGraphFlowDshGlue(content: string): boolean {
  if (content.includes(DSH_GLUE_PACKAGE)) {
    return true;
  }
  return new RegExp(`^\\s*-\\s*id:\\s*${DSH_GLUE_ROW_ID}\\s*$`, "m").test(content);
}

function upsertManagedPatch(existing: string, managed: string): { next: string; changed: boolean; kind: "created" | "updated" | "skipped" } {
  const beginIdx = existing.indexOf(DSH_PATCH_BEGIN);
  const endIdx = existing.indexOf(DSH_PATCH_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + DSH_PATCH_END.length).replace(/^\n/, "");
    const next = `${before}${managed}${after}`.replace(/\n{3,}/g, "\n\n");
    if (next === existing) {
      return { next, changed: false, kind: "skipped" };
    }
    return { next, changed: true, kind: "updated" };
  }

  if (!existing.trim()) {
    return { next: managed, changed: true, kind: "created" };
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { next: `${existing}${separator}${managed}`, changed: true, kind: "updated" };
}

export function removeManagedDshPatch(content: string): { next: string; removed: boolean } {
  const beginIdx = content.indexOf(DSH_PATCH_BEGIN);
  const endIdx = content.indexOf(DSH_PATCH_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return { next: content, removed: false };
  }
  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + DSH_PATCH_END.length).replace(/^\n/, "");
  return { next: `${before}${after}`.replace(/\n{3,}/g, "\n\n").trimStart(), removed: true };
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeJsonObject(path: string, value: Record<string, unknown>): void {
  // UTF-8 without BOM — dsh JSON.parse rejects BOM.
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

/** Ensure `dsh.profile.bundles` lists `@roarpeng/graphflow` so Cordis applies the bundle patch. */
export function ensureGraphFlowBundleInProfilePackageJson(profileDir: string): boolean {
  const pkgPath = join(profileDir, "package.json");
  const pkg = readJsonObject(pkgPath);
  if (!pkg) return false;

  const dsh = (pkg.dsh && typeof pkg.dsh === "object" && !Array.isArray(pkg.dsh)
    ? { ...(pkg.dsh as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  const profile = (dsh.profile && typeof dsh.profile === "object" && !Array.isArray(dsh.profile)
    ? { ...(dsh.profile as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  const bundles = Array.isArray(profile.bundles)
    ? profile.bundles.filter((b): b is string => typeof b === "string")
    : [];
  if (bundles.includes(DSH_PACKAGE_NAME)) {
    return false;
  }
  profile.bundles = [...bundles, DSH_PACKAGE_NAME];
  dsh.profile = profile;
  pkg.dsh = dsh;
  writeJsonObject(pkgPath, pkg);
  return true;
}

/**
 * Best-effort install of `@roarpeng/graphflow` into a dsh profile directory.
 * Prefer the official `dsh plugin --profile web add @roarpeng/graphflow` when available.
 */
export function ensureGraphFlowPackageInProfile(
  dshHome = resolveDshHome(),
  profile = DSH_DEFAULT_PROFILE
): { ok: boolean; message: string } {
  const profileDir = getDshProfileDir(dshHome, profile);
  const pkgPath = join(profileDir, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      ok: false,
      message: `profile package.json not found at ${pkgPath}; run: dsh plugin --profile ${profile} add ${DSH_PACKAGE_NAME}`,
    };
  }
  if (isGraphFlowPackageInProfile(dshHome, profile)) {
    ensureGraphFlowBundleInProfilePackageJson(profileDir);
    return { ok: true, message: "already installed" };
  }

  try {
    // Omit optional native addons (better-sqlite3): they often hang/fail on Windows
    // and are not required for the dsh glue / MCP npx path.
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", DSH_PACKAGE_NAME, "--save", "--omit=optional", "--no-fund", "--no-audit"],
      {
        cwd: profileDir,
        encoding: "utf8",
        timeout: 180_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `npm install ${DSH_PACKAGE_NAME} failed in ${profileDir}: ${detail}. Run: dsh plugin --profile ${profile} add ${DSH_PACKAGE_NAME}`,
    };
  }

  ensureGraphFlowBundleInProfilePackageJson(profileDir);
  if (!isGraphFlowPackageInProfile(dshHome, profile)) {
    return {
      ok: false,
      message: `package still missing after npm install; run: dsh plugin --profile ${profile} add ${DSH_PACKAGE_NAME}`,
    };
  }
  return { ok: true, message: `installed ${DSH_PACKAGE_NAME} into ${profileDir}` };
}

function glueOmittedMessage(profile: string): string {
  return (
    `MCP overlay only; glue omitted until ${DSH_PACKAGE_NAME} is installed in profiles/${profile} ` +
    `(run: dsh plugin --profile ${profile} add ${DSH_PACKAGE_NAME})`
  );
}

function writeOrRemovePatchFile(patchPath: string, next: string): void {
  // dsh requires an existing cordis.patch.yml to be a top-level YAML array.
  // An empty file throws; remove the file when there is no remaining content.
  if (!next.trim()) {
    if (existsSync(patchPath)) {
      unlinkSync(patchPath);
    }
    return;
  }
  writeFileSync(patchPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}

function clearHomeOverlayIfPresent(paths: DshHarnessPaths): DshHarnessInstallResult | null {
  if (!existsSync(paths.patchPath)) {
    return null;
  }
  const existing = readFileSync(paths.patchPath, "utf8");
  if (!patchContainsGraphFlowDsh(existing)) {
    return null;
  }
  const { next, removed } = removeManagedDshPatch(existing);
  if (!removed) {
    return null;
  }
  writeOrRemovePatchFile(paths.patchPath, next);
  return {
    status: "updated",
    filePath: paths.patchPath,
    message: `package present in profile; cleared home overlay (bundle owns MCP+glue via ${DSH_PACKAGE_NAME})`,
  };
}

export function getDshHarnessStatus(options: { dshHome?: string; profile?: string } = {}): DshHarnessStatus {
  const paths = getDshHarnessPaths(resolveDshHome(options.dshHome));
  const profile = options.profile?.trim() || DSH_DEFAULT_PROFILE;
  const profileDir = getDshProfileDir(paths.dshHome, profile);
  const detected = existsSync(paths.dshHome);
  const packageInstalled = isGraphFlowPackageInProfile(paths.dshHome, profile);
  let installed = false;
  let glueInstalled = false;
  if (detected && existsSync(paths.patchPath)) {
    try {
      const content = readFileSync(paths.patchPath, "utf8");
      installed = patchContainsGraphFlowDsh(content);
      glueInstalled = patchContainsGraphFlowDshGlue(content);
    } catch {
      installed = false;
      glueInstalled = false;
    }
  }
  // Bundle install via `dsh plugin add` may provide MCP+glue without a home overlay.
  if (packageInstalled) {
    installed = true;
    glueInstalled = true;
  }
  return {
    agent: dshAdapterDisplayName(),
    detected,
    installed,
    glueInstalled,
    packageInstalled,
    skillInstalled: existsSync(paths.skillPath),
    dshHome: paths.dshHome,
    patchPath: paths.patchPath,
    skillPath: paths.skillPath,
    profileDir,
  };
}

export function installDshHarness(options: DshHarnessInstallOptions = {}): DshHarnessInstallResult {
  const paths = getDshHarnessPaths(resolveDshHome(options.dshHome));
  const profile = options.profile?.trim() || DSH_DEFAULT_PROFILE;
  if (!existsSync(paths.dshHome)) {
    return {
      status: "skipped",
      filePath: paths.patchPath,
      message: `${dshAdapterDisplayName()} not detected`,
    };
  }

  try {
    const notes: string[] = [];
    if (options.ensurePackage) {
      const ensured = ensureGraphFlowPackageInProfile(paths.dshHome, profile);
      notes.push(ensured.message);
    }

    const packagePresent = isGraphFlowPackageInProfile(paths.dshHome, profile);
    if (packagePresent) {
      ensureGraphFlowBundleInProfilePackageJson(getDshProfileDir(paths.dshHome, profile));
      const cleared = clearHomeOverlayIfPresent(paths);
      if (cleared) {
        if (notes.length) cleared.message = `${cleared.message}; ${notes.join("; ")}`;
        return cleared;
      }
      return {
        status: "skipped",
        filePath: paths.patchPath,
        message: notes.length
          ? `package present in profile; home overlay not needed; ${notes.join("; ")}`
          : `package present in profile; home overlay not needed (bundle owns MCP+glue)`,
      };
    }

    // Package missing: MCP-only home overlay (never glue — keeps dsh bootable).
    const includeGlue = options.includeGlue === true;
    mkdirSync(dirname(paths.patchPath), { recursive: true });
    const existing = existsSync(paths.patchPath) ? readFileSync(paths.patchPath, "utf8") : "";
    const managed = wrapDshManagedPatch(buildGraphFlowDshInsertPatch({ includeGlue }));
    const { next, kind } = upsertManagedPatch(existing, managed);
    if (kind === "skipped") {
      return {
        status: "skipped",
        filePath: paths.patchPath,
        message: includeGlue
          ? notes.length
            ? `already up to date; ${notes.join("; ")}`
            : "already up to date"
          : glueOmittedMessage(profile),
      };
    }
    writeFileSync(paths.patchPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    const baseMessage = includeGlue ? undefined : glueOmittedMessage(profile);
    const message = [baseMessage, ...notes].filter((part): part is string => Boolean(part)).join("; ");
    if (message) {
      return { status: kind, filePath: paths.patchPath, message };
    }
    return { status: kind, filePath: paths.patchPath };
  } catch (error) {
    return {
      status: "error",
      filePath: paths.patchPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function uninstallDshHarness(options: { dshHome?: string } = {}): DshHarnessInstallResult {
  const paths = getDshHarnessPaths(resolveDshHome(options.dshHome));
  if (!existsSync(paths.patchPath)) {
    return {
      status: "skipped",
      filePath: paths.patchPath,
      message: "not found",
    };
  }

  try {
    const existing = readFileSync(paths.patchPath, "utf8");
    const { next, removed } = removeManagedDshPatch(existing);
    if (!removed) {
      return { status: "skipped", filePath: paths.patchPath, message: "no GraphFlow block" };
    }
    if (!next.trim()) {
      writeOrRemovePatchFile(paths.patchPath, "");
    } else {
      writeOrRemovePatchFile(paths.patchPath, next);
    }
    return { status: "updated", filePath: paths.patchPath, message: "removed GraphFlow MCP+glue insert" };
  } catch (error) {
    return {
      status: "error",
      filePath: paths.patchPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
