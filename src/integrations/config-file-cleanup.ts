/**
 * Uninstall helpers: never leave `{}` / `{"hooks":{}}` stubs or empty
 * `graphflow-hooks/` directories behind in host config homes.
 */
import { existsSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/**
 * True when nothing but empty containers (and keys GraphFlow itself adds, such
 * as Cursor's `version`) remain — i.e. the file carries no user configuration.
 */
export function isEffectivelyEmptyJson(json: Record<string, unknown>, ownedKeys: readonly string[] = []): boolean {
  return Object.entries(json).every(([key, value]) => ownedKeys.includes(key) || isEmptyValue(value));
}

/**
 * Persist a config after GraphFlow removed its entries. When nothing of the
 * user's remains the file is deleted instead of being left as an empty stub.
 */
export function writeJsonOrRemove(
  filePath: string,
  json: Record<string, unknown>,
  ownedKeys: readonly string[] = []
): "written" | "removed" {
  if (isEffectivelyEmptyJson(json, ownedKeys)) {
    rmSync(filePath, { force: true });
    return "removed";
  }
  writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return "written";
}

export function removeDirIfEmpty(dirPath: string): boolean {
  try {
    if (existsSync(dirPath) && readdirSync(dirPath).length === 0) {
      rmdirSync(dirPath);
      return true;
    }
  } catch {
    // best effort: a non-empty or locked directory stays
  }
  return false;
}

function dirKey(dir: string): string {
  const full = resolve(dir);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/**
 * After removing a GraphFlow file, remove the directories it left empty
 * (`skills/`, `rules/`, a project `.cursor/`), walking upward until a
 * non-empty directory. Never removes home, the per-user app-data roots, the
 * current working directory or a filesystem root.
 */
export function pruneEmptyDirsUpward(startDir: string, extraStops: readonly string[] = []): void {
  const home = homedir();
  const stops = new Set(
    [
      home,
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"),
      process.cwd(),
      ...extraStops,
    ].map(dirKey)
  );
  let dir = resolve(startDir);
  while (!stops.has(dirKey(dir)) && dirname(dir) !== dir) {
    if (!removeDirIfEmpty(dir)) return;
    dir = dirname(dir);
  }
}
