import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_REPOSITORY_URL,
  TRUSTED_PUBLISHER_WORKFLOW,
  formatOidcExchangeFailureMessage,
  isCanonicalRepositoryUrl,
  isOidcExchangeFailure,
} from "../scripts/npm-oidc-publish-lib.cjs";

describe("npm OIDC trusted-publish diagnostics", () => {
  it("treats the registry OIDC exchange 404 as a trusted-publisher mismatch", () => {
    const log = [
      "npm http fetch GET https://example.actions.githubusercontent.com/idtoken 200",
      "npm http fetch POST 404 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@roarpeng%2fgraphflow",
      "npm verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found",
      "npm error code ENEEDAUTH",
    ].join("\n");
    expect(isOidcExchangeFailure(log)).toBe(true);
    expect(isOidcExchangeFailure("npm error code ENEEDAUTH\nnpm error need auth")).toBe(true);
    expect(isOidcExchangeFailure("npm error code E403")).toBe(false);
  });

  it("tells operators the exact Trusted Publisher fields and repository.url form", () => {
    const message = formatOidcExchangeFailureMessage();
    expect(message).toContain("Roarpeng");
    expect(message).toContain("GraphFlow");
    expect(message).toContain(TRUSTED_PUBLISHER_WORKFLOW);
    expect(message).not.toContain(".github/workflows/");
    expect(message).toContain("npm publish");
    expect(message).toContain(CANONICAL_REPOSITORY_URL);
    expect(message).toContain("git+");
  });

  it("keeps package.json repository.url in the provenance/OIDC canonical form", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(isCanonicalRepositoryUrl(pkg.repository?.url)).toBe(true);
    expect(pkg.repository.url).not.toMatch(/^git\+/);
    expect(pkg.repository.url).not.toMatch(/\.git$/);
  });
});
