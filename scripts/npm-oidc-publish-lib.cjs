/**
 * Operator-facing npm OIDC publish diagnostics (CJS for Windows vitest + CLI).
 *
 * npm collapses trusted-publisher mismatches into ENEEDAUTH / "package not found".
 * The GitHub id-token exchange succeeding (HTTP 200) then failing at
 * POST /-/npm/v1/oidc/token/exchange is a registry-side config mismatch, not a
 * missing Actions permission.
 */

const CANONICAL_REPOSITORY_URL = "https://github.com/Roarpeng/GraphFlow";
const TRUSTED_PUBLISHER_WORKFLOW = "publish-npm.yml";

function isOidcExchangeFailure(combined) {
  const text = String(combined || "");
  return (
    /ENEEDAUTH/i.test(text) ||
    /OIDC token exchange error - package not found/i.test(text) ||
    /\/-\/npm\/v1\/oidc\/token\/exchange\//i.test(text)
  );
}

function formatOidcExchangeFailureMessage() {
  return [
    "npm OIDC token exchange failed (ENEEDAUTH / 'package not found').",
    "GitHub already issued the id-token; the registry rejected the trusted-publisher match.",
    "Check, case-sensitively, on npmjs.com → @roarpeng/graphflow → Trusted Publisher:",
    "  Organization or user: Roarpeng",
    "  Repository:           GraphFlow",
    `  Workflow filename:    ${TRUSTED_PUBLISHER_WORKFLOW}  (filename only — not 'Publish npm', not a path)`,
    "  Environment name:     leave empty (this job has no GitHub environment)",
    "  Allowed actions:      enable npm publish (configs created after 2026-09-03 default to stage-only)",
    `package.json repository.url must be exactly ${CANONICAL_REPOSITORY_URL} (no git+ prefix, no .git suffix).`,
  ].join("\n");
}

function isCanonicalRepositoryUrl(url) {
  return String(url || "") === CANONICAL_REPOSITORY_URL;
}

module.exports = {
  CANONICAL_REPOSITORY_URL,
  TRUSTED_PUBLISHER_WORKFLOW,
  isOidcExchangeFailure,
  formatOidcExchangeFailureMessage,
  isCanonicalRepositoryUrl,
};
