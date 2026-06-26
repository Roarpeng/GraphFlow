import { ALL_LANGUAGE_EXTENSIONS } from "../graph/language-indexers/index.js";

/** Documentation/config files indexed alongside source code. */
export const BASE_DOC_EXTENSIONS = [".md", ".json"] as const;

/**
 * Narrow extension list used in early GraphFlow releases and loader fallbacks.
 * Projects with only these extensions miss native language indexing (C/C++, Python, etc.).
 */
export const LEGACY_WEB_ONLY_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".md",
  ".json",
] as const;

/** Full default scan set: all language indexers plus common docs. */
export const DEFAULT_INCLUDE_EXTENSIONS: string[] = Array.from(
  new Set([...ALL_LANGUAGE_EXTENSIONS, ...BASE_DOC_EXTENSIONS])
);

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** True when the configured list exactly matches the legacy 6-item web-only default. */
export function isLegacyWebOnlyExtensions(extensions: string[]): boolean {
  const normalized = Array.from(new Set(extensions.map(normalizeExtension))).sort();
  const legacy = [...LEGACY_WEB_ONLY_EXTENSIONS].map(normalizeExtension).sort();
  if (normalized.length !== legacy.length) {
    return false;
  }
  return normalized.every((ext, index) => ext === legacy[index]);
}

/**
 * Resolve effective includeExtensions for indexing.
 * Upgrades legacy web-only configs by unioning all registered language extensions.
 */
export function resolveIncludeExtensions(configured?: string[]): string[] {
  if (!configured || configured.length === 0) {
    return [...DEFAULT_INCLUDE_EXTENSIONS];
  }

  const normalized = configured.map(normalizeExtension);
  if (isLegacyWebOnlyExtensions(normalized)) {
    return [...DEFAULT_INCLUDE_EXTENSIONS];
  }

  return Array.from(new Set(normalized));
}
