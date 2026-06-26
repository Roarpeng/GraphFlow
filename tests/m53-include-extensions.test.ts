import { describe, expect, it } from "vitest";
import {
  DEFAULT_INCLUDE_EXTENSIONS,
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
});
