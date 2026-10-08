import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TRUSTED_PUBLISH_NPM,
  classifyNpmPublishFailure,
  formatEotpOperatorMessage,
  hasGithubOidc,
  npmPublishArgv,
  oidcPublishEnv,
  resolveNpmToken,
  stripNpmTokens,
  writeOidcNpmrc,
} from "../scripts/npm-publish-lib.cjs";

describe("npm idempotent publish helper", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies EOTP separately from already-published and missing auth", () => {
    expect(
      classifyNpmPublishFailure(
        "npm error code EOTP\nnpm error This operation requires a one-time password from your authenticator."
      )
    ).toBe("eotp");
    expect(
      classifyNpmPublishFailure(
        "npm ERR! code E403\nnpm ERR! 403 403 Forbidden - PUT - cannot publish over the previously published versions"
      )
    ).toBe("already-published");
    expect(
      classifyNpmPublishFailure(
        "npm error code ENEEDAUTH\nnpm error This command requires you to be logged in to https://registry.npmjs.org/"
      )
    ).toBe("need-auth");
    expect(classifyNpmPublishFailure("npm error code E404")).toBe("other");
  });

  it("strips tokens and points npm at a registry-only userconfig for OIDC", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphflow-npm-oidc-test-"));
    dirs.push(dir);
    const npmrc = writeOidcNpmrc(join(dir, ".npmrc"));
    expect(readFileSync(npmrc, "utf8")).toBe("registry=https://registry.npmjs.org/\n");
    expect(readFileSync(npmrc, "utf8")).not.toContain("_authToken");

    const env = oidcPublishEnv(
      {
        NODE_AUTH_TOKEN: "secret",
        NPM_TOKEN: "also-secret",
        npm_token: "legacy",
        PATH: "/usr/bin",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test",
      },
      npmrc
    );
    expect(env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.npm_token).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBe(npmrc);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("detects GitHub OIDC and token secrets independently", () => {
    expect(hasGithubOidc({})).toBe(false);
    expect(
      hasGithubOidc({
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "tok",
      })
    ).toBe(true);
    expect(resolveNpmToken({ NODE_AUTH_TOKEN: "a" })).toBe("a");
    expect(resolveNpmToken({ NPM_TOKEN: "b" })).toBe("b");
    expect(stripNpmTokens({ NODE_AUTH_TOKEN: "a", KEEP: "1" })).toEqual({ KEEP: "1" });
  });

  it("runs OIDC publish through npx npm@11.6+ so Corepack cannot pin npm 10", () => {
    const argv = npmPublishArgv("oidc", { userconfig: "/tmp/oidc.npmrc" });
    expect(argv.command).toBe("npx");
    expect(argv.args).toEqual([
      "--yes",
      `npm@${TRUSTED_PUBLISH_NPM}`,
      "publish",
      "--access",
      "public",
      "--userconfig",
      "/tmp/oidc.npmrc",
    ]);
    expect(npmPublishArgv("token")).toEqual({
      command: "npm",
      args: ["publish", "--access", "public"],
    });
  });

  it("tells operators that whoami is not sufficient and how to fix EOTP", () => {
    const message = formatEotpOperatorMessage();
    expect(message).toContain("EOTP");
    expect(message).toContain("npm whoami");
    expect(message).toContain("Trusted Publisher");
    expect(message).toContain(".github/workflows/publish-npm.yml");
  });

  it("wires Publish npm to retry OIDC without treating whoami as publish proof", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/publish-npm.yml"),
      "utf8"
    );
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("GitHub OIDC is available");
    expect(workflow).toContain("whoami only proves identity");
    expect(workflow).toContain("publish-npm-idempotent.mjs");
    expect(workflow).not.toMatch(
      /if \[ -z "\$\{NODE_AUTH_TOKEN\}" \]; then\n\s+echo "::error::NODE_AUTH_TOKEN is empty/
    );
  });
});
