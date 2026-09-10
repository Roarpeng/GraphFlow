/**
 * Shared npm publish helpers (CJS for Windows vitest + CLI script).
 *
 * Token + 2FA (EOTP) cannot be satisfied in CI. Trusted Publishing (GitHub OIDC)
 * is the durable path; a 2FA-bypass granular token is a temporary fallback.
 */

const { writeFileSync } = require("node:fs");

const TRUSTED_PUBLISH_NPM = "11.6.2";
const OIDC_REGISTRY_NPMRC = "registry=https://registry.npmjs.org/\n";

function classifyNpmPublishFailure(combined) {
  const text = String(combined || "");
  if (/EOTP/i.test(text) || /one-time password from your authenticator/i.test(text)) {
    return "eotp";
  }
  if (
    /E403/.test(text) &&
    /cannot publish over the previously published versions/i.test(text)
  ) {
    return "already-published";
  }
  if (/ENEEDAUTH/i.test(text) || /This command requires you to be logged in/i.test(text)) {
    return "need-auth";
  }
  return "other";
}

function hasGithubOidc(env = process.env) {
  return Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

function resolveNpmToken(env = process.env) {
  return env.NODE_AUTH_TOKEN || env.NPM_TOKEN || env.npm_token || "";
}

function stripNpmTokens(env) {
  const next = { ...env };
  delete next.NODE_AUTH_TOKEN;
  delete next.NPM_TOKEN;
  delete next.npm_token;
  return next;
}

function writeOidcNpmrc(filePath) {
  writeFileSync(filePath, OIDC_REGISTRY_NPMRC, "utf8");
  return filePath;
}

function oidcPublishEnv(baseEnv, npmrcPath) {
  const env = stripNpmTokens(baseEnv);
  env.NPM_CONFIG_USERCONFIG = npmrcPath;
  return env;
}

function formatEotpOperatorMessage() {
  return [
    "npm publish failed with EOTP: the configured token requires a one-time password (2FA).",
    "`npm whoami` succeeding does not prove the token can publish — identity tokens with 2FA still prompt for OTP on write.",
    "Fix one of:",
    "  1. Preferred: on npmjs.com → @roarpeng/graphflow → Trusted Publisher, add GitHub repo Roarpeng/GraphFlow and workflow `.github/workflows/publish-npm.yml`, then re-run Publish npm. This job already has `id-token: write` and retries OIDC without NODE_AUTH_TOKEN.",
    "  2. Temporary: replace the npm_token / NPM_TOKEN secret with a granular automation token that bypasses 2FA (npm is sunsetting these; trusted publishing is the durable path).",
  ].join("\n");
}

function npmPublishArgv(mode, { userconfig } = {}) {
  if (mode === "oidc") {
    const args = ["--yes", `npm@${TRUSTED_PUBLISH_NPM}`, "publish", "--access", "public"];
    if (userconfig) args.push("--userconfig", userconfig);
    return { command: "npx", args };
  }
  const args = ["publish", "--access", "public"];
  if (userconfig) args.push("--userconfig", userconfig);
  return { command: "npm", args };
}

module.exports = {
  TRUSTED_PUBLISH_NPM,
  OIDC_REGISTRY_NPMRC,
  classifyNpmPublishFailure,
  hasGithubOidc,
  resolveNpmToken,
  stripNpmTokens,
  writeOidcNpmrc,
  oidcPublishEnv,
  formatEotpOperatorMessage,
  npmPublishArgv,
};
