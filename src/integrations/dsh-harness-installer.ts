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
 * 3. When any `profiles/<profile>/cordis.patch.yml` already declares the MCP row
 *    (hand-written or from an older install), that profile layer owns it. The home
 *    overlay applies over *every* profile, so writing it there too makes Cordis throw
 *    `duplicate loader entry id: mcp-graphflow` at boot. `graphflow install` then
 *    removes any managed home overlay and reports the owning profile patch.
 *
 * Skills go to `$DSH_HOME/skills/graphflow/SKILL.md` via skill-installer targets;
 * the bundle glue also registers the skill at runtime so `dsh plugin add` is enough.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  /** Profile patch that owns the MCP row, e.g. `profiles/web/cordis.patch.yml`; null when none. */
  profilePatchOwner: string | null;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate the managed block. Markers must sit on their own line: a plain `indexOf`
 * also matches the marker text when a comment merely *mentions* it, which sliced the
 * file mid-comment and silently dropped the top-level `[]`.
 * Returns `beginIdx` (start of the BEGIN line) and `endIdx` (exclusive end of the END marker).
 */
function findManagedPatchBlock(content: string): { beginIdx: number; endIdx: number } | null {
  const beginRe = new RegExp(`^[ \\t]*${escapeRegExp(DSH_PATCH_BEGIN)}[ \\t]*$`, "m");
  const beginMatch = beginRe.exec(content);
  if (beginMatch) {
    const endRe = new RegExp(`^[ \\t]*${escapeRegExp(DSH_PATCH_END)}[ \\t]*$`, "gm");
    endRe.lastIndex = beginMatch.index + beginMatch[0].length;
    const endMatch = endRe.exec(content);
    if (endMatch) {
      return { beginIdx: beginMatch.index, endIdx: endMatch.index + endMatch[0].length };
    }
  }

  // Recovery for files an older `indexOf`-based writer already corrupted: the BEGIN
  // marker is embedded in a comment line. Drop that whole line rather than leave a
  // truncated sentence behind.
  const rawBegin = content.indexOf(DSH_PATCH_BEGIN);
  const rawEnd = content.indexOf(DSH_PATCH_END);
  if (rawBegin === -1 || rawEnd === -1 || rawEnd <= rawBegin) {
    return null;
  }
  return {
    beginIdx: content.lastIndexOf("\n", rawBegin) + 1,
    endIdx: rawEnd + DSH_PATCH_END.length,
  };
}

function stripCommentLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Keep the patch a valid top-level YAML array. dsh parses `cordis.patch.yml` as an
 * array: comments followed by `[]` **and** `- insert:` items is a parse error, and a
 * comments-only file parses to null. So drop a bare `[]` when items exist, and restore
 * it when only comments remain.
 */
function normalizePatchArray(content: string): string {
  const withoutEmptyArray = content
    .split("\n")
    .filter((line) => line.trim() !== "[]")
    .join("\n");
  if (!withoutEmptyArray.trim()) {
    return "";
  }
  if (/^-/m.test(stripCommentLines(withoutEmptyArray))) {
    return withoutEmptyArray;
  }
  return `${withoutEmptyArray.trimEnd()}\n[]\n`;
}

function upsertManagedPatch(existing: string, managed: string): { next: string; changed: boolean; kind: "created" | "updated" | "skipped" } {
  const block = findManagedPatchBlock(existing);

  if (block) {
    const before = existing.slice(0, block.beginIdx);
    const after = existing.slice(block.endIdx).replace(/^\r?\n/, "");
    const next = normalizePatchArray(`${before}${managed}${after}`.replace(/\n{3,}/g, "\n\n"));
    if (next === existing) {
      return { next, changed: false, kind: "skipped" };
    }
    return { next, changed: true, kind: "updated" };
  }

  if (!existing.trim()) {
    return { next: normalizePatchArray(managed), changed: true, kind: "created" };
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return {
    next: normalizePatchArray(`${existing}${separator}${managed}`),
    changed: true,
    kind: "updated",
  };
}

export function removeManagedDshPatch(content: string): { next: string; removed: boolean } {
  const block = findManagedPatchBlock(content);
  if (!block) {
    return { next: content, removed: false };
  }
  const before = content.slice(0, block.beginIdx);
  const after = content.slice(block.endIdx).replace(/^\r?\n/, "");
  const next = normalizePatchArray(`${before}${after}`.replace(/\n{3,}/g, "\n\n").trimStart());
  return { next, removed: true };
}

export interface DshProfilePatchOwner {
  profile: string;
  /** Path of the profile's own `cordis.patch.yml`. */
  patchPath: string;
  /** Relative label used in messages, e.g. `profiles/web/cordis.patch.yml`. */
  label: string;
}

function readPatchFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Profiles whose own `cordis.patch.yml` already declares the GraphFlow MCP row.
 * The home overlay applies over *every* profile, so a row in either layer makes Cordis
 * abort boot. Detection is marker-independent on purpose: hand-written profile rows
 * carry no GRAPHFLOW-DSH-BEGIN/END wrapper.
 */
export function findDshProfilePatchOwners(
  dshHome = resolveDshHome(),
  profile?: string
): DshProfilePatchOwner[] {
  const profilesRoot = join(dshHome, "profiles");
  const wanted = profile?.trim();
  let names: string[];
  try {
    names = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const owners: DshProfilePatchOwner[] = [];
  for (const name of names) {
    if (wanted && name !== wanted) continue;
    const patchPath = join(profilesRoot, name, "cordis.patch.yml");
    const content = readPatchFile(patchPath);
    if (content === null) continue;
    if (!patchContainsGraphFlowDsh(content)) continue;
    owners.push({ profile: name, patchPath, label: `profiles/${name}/cordis.patch.yml` });
  }
  return owners.sort((a, b) => a.profile.localeCompare(b.profile));
}

function profileOwnerWarning(owners: DshProfilePatchOwner[]): string | null {
  if (owners.length === 0) return null;
  const list = owners.map((owner) => owner.label).join(", ");
  return (
    `WARNING: ${list} also declares ${DSH_MCP_ROW_ID}; that row plus the bundle layer aborts dsh ` +
    `boot with "duplicate loader entry id". Remove the row from the profile patch.`
  );
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

function clearHomeOverlayIfPresent(
  paths: DshHarnessPaths,
  message: string
): DshHarnessInstallResult | null {
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
    message,
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
  const profileOwners = findDshProfilePatchOwners(paths.dshHome);
  // A profile-owned row means the MCP bridge is live even with no home overlay.
  if (profileOwners.length > 0) {
    installed = true;
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
    profilePatchOwner: profileOwners[0]?.label ?? null,
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
      const profileOwners = findDshProfilePatchOwners(paths.dshHome);
      if (packagePresent) {
        ensureGraphFlowBundleInProfilePackageJson(getDshProfileDir(paths.dshHome, profile));
        const cleared = clearHomeOverlayIfPresent(
          paths,
          `package present in profile; cleared home overlay (bundle owns MCP+glue via ${DSH_PACKAGE_NAME})`
        );
        if (cleared) {
          if (notes.length) cleared.message = `${cleared.message}; ${notes.join("; ")}`;
          return cleared;
        }
        const conflict = profileOwnerWarning(profileOwners);
        const baseMessage = notes.length
          ? `package present in profile; home overlay not needed; ${notes.join("; ")}`
          : `package present in profile; home overlay not needed (bundle owns MCP+glue)`;
        return {
          status: "skipped",
          filePath: paths.patchPath,
          message: conflict ? `${baseMessage}. ${conflict}` : baseMessage,
        };
      }

      // A profile patch that already declares the row owns it. Writing the home overlay
      // as well is what produced `duplicate loader entry id: mcp-graphflow`.
      if (profileOwners.length > 0) {
        const ownerList = profileOwners.map((owner) => owner.label).join(", ");
        const skipReason = `${ownerList} already declares ${DSH_MCP_ROW_ID}; home overlay skipped to avoid duplicate loader entry id`;
        const cleared = clearHomeOverlayIfPresent(
          paths,
          `${ownerList} already declares ${DSH_MCP_ROW_ID}; cleared home overlay to avoid duplicate loader entry id`
        );
        const base = cleared?.message ?? skipReason;
        return {
          status: cleared ? "updated" : "skipped",
          filePath: paths.patchPath,
          message: notes.length ? `${base}; ${notes.join("; ")}` : base,
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
      writeOrRemovePatchFile(paths.patchPath, next);
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
