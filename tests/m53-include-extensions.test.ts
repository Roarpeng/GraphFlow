import { describe, expect, it } from "vitest";
import {
  DEFAULT_INCLUDE_EXTENSIONS,
  applyDocumentIndexScope,
  hasMarkdownIndex,
  hasOfficeIndex,
  isLegacyWebOnlyExtensions,
  LEGACY_WEB_ONLY_EXTENSIONS,
  resolveIncludeExtensions,
} from "../src/config/include-extensions.js";

describe("include-extensions resolver", () => {
  it("detects legacy web-only extension lists", () => {
    expect(isLegacyWebOnlyExtensions([...LEGACY_WEB_ONLY_EXTENSIONS])).toBe(true);
    expect(isLegacyWebOnlyExtensions([".ts", ".md"])).toBe(false);
    expect(isLegacyWebOnlyExtensions([".cpp", ".md"])).toBe(false);
    expect(isLegacyWebOnlyExtensions(DEFAULT_INCLUDE_EXTENSIONS)).toBe(false);
  });

  it("upgrades legacy lists to include native language extensions", () => {
    const resolved = resolveIncludeExtensions([...LEGACY_WEB_ONLY_EXTENSIONS]);
    expect(resolved).toContain(".cpp");
    expect(resolved).toContain(".hpp");
    expect(resolved).toContain(".py");
    expect(resolved).toContain(".ts");
  });

  it("returns full defaults when includeExtensions is missing", () => {
    const resolved = resolveIncludeExtensions(undefined);
    expect(resolved).toContain(".cpp");
    expect(resolved.length).toBeGreaterThanOrEqual(DEFAULT_INCLUDE_EXTENSIONS.length);
  });

  it("preserves explicit single-extension subsets", () => {
    expect(resolveIncludeExtensions([".ts"])).toEqual([".ts"]);
  });

  it("toggles markdown and office document indexing without dropping languages", () => {
    const withDocs = applyDocumentIndexScope([".ts", ".md", ".pdf"], { markdown: true, office: true });
    expect(withDocs).toContain(".ts");
    expect(withDocs).toContain(".md");
    expect(withDocs).toContain(".pdf");
    expect(hasMarkdownIndex(withDocs)).toBe(true);
    expect(hasOfficeIndex(withDocs)).toBe(true);

    const codeOnly = applyDocumentIndexScope(withDocs, { markdown: false, office: false });
    expect(codeOnly).toContain(".ts");
    expect(codeOnly).not.toContain(".md");
    expect(codeOnly).not.toContain(".pdf");
    expect(hasMarkdownIndex(codeOnly)).toBe(false);
    expect(hasOfficeIndex(codeOnly)).toBe(false);
  });
});
