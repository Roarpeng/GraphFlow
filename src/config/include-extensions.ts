import { ALL_LANGUAGE_EXTENSIONS } from "../graph/language-indexers/index.js";
import { OFFICE_DOCUMENT_EXTENSIONS } from "../graph/document-convert.js";

/** Documentation/config files indexed alongside source code. */
export const BASE_DOC_EXTENSIONS = [".md", ".json"] as const;

/** Office/PDF documents converted to Markdown then indexed (optional @firecrawl/anydoc). */
export const OFFICE_DOC_EXTENSIONS = OFFICE_DOCUMENT_EXTENSIONS;

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

/** Full default scan set: all language indexers plus common docs and office/PDF. */
export const DEFAULT_INCLUDE_EXTENSIONS: string[] = Array.from(
  new Set([...ALL_LANGUAGE_EXTENSIONS, ...BASE_DOC_EXTENSIONS, ...OFFICE_DOC_EXTENSIONS])
);

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

const OFFICE_EXTENSION_SET = new Set<string>(OFFICE_DOC_EXTENSIONS);

export function hasMarkdownIndex(extensions: string[] | undefined): boolean {
  return resolveIncludeExtensions(extensions).includes(".md");
}

export function hasOfficeIndex(extensions: string[] | undefined): boolean {
  return resolveIncludeExtensions(extensions).some((ext) => OFFICE_EXTENSION_SET.has(ext));
}

/** Apply Settings-page document toggles without dropping language extensions. */
export function applyDocumentIndexScope(
  configured: string[] | undefined,
  scope: { markdown: boolean; office: boolean }
): string[] {
  const current = resolveIncludeExtensions(configured);
  const withoutDocs = current.filter((ext) => ext !== ".md" && !OFFICE_EXTENSION_SET.has(ext));
  const next = [...withoutDocs];
  if (scope.markdown) {
    next.push(".md");
  }
  if (scope.office) {
    next.push(...OFFICE_DOC_EXTENSIONS);
  }
  return Array.from(new Set(next.map(normalizeExtension)));
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
