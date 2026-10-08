#!/usr/bin/env node
/**
 * Idempotent npm publish for CI.
 *
 * Auth order (OIDC first — a token can not satisfy 2FA in CI):
 *   1. GitHub OIDC Trusted Publishing (no NODE_AUTH_TOKEN, npx npm@11.6.2,
 *      registry-only temp userconfig with tokens stripped from env)
 *   2. NODE_AUTH_TOKEN / NPM_TOKEN (fails with EOTP if the token requires 2FA;
 *      on EOTP the loop continues to the next auth method instead of dying)
 *
 * If the package version is already on the registry (or publish returns E403
 * "cannot publish over the previously published versions"), exit 0.
 *
 * A publish exit code of 0 is NOT trusted on its own (live: OIDC publish once
 * exited 0 with full notices + provenance while the packument never changed):
 * success is verified against the origin registry afterwards, reading
 * dist-tags straight from the origin (CDN edge caches serve stale packuments
 * for minutes — `npm view` alone lied for 80s on the v2.2.0 run).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  classifyNpmPublishFailure,
  formatEotpOperatorMessage,
  hasGithubOidc,
  npmPublishArgv,
  oidcPublishEnv,
  resolveNpmToken,
  writeOidcNpmrc,
} = require("./npm-publish-lib.cjs");
const {
  formatOidcExchangeFailureMessage,
  isOidcExchangeFailure,
} = require("./npm-oidc-publish-lib.cjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { name, version } = pkg;

function npmViewVersion() {
  const result = spawnSync("npm", ["view", name, "version"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || "").trim() || null;
}

/**
 * Read dist-tags straight from the origin registry with cache-busting.
 * `npm view` negotiates with CDN edge caches that can serve a stale
 * packument for minutes after a successful publish (live: v2.2.0's run
 * polled `npm view` every 10s for 80s — all 2.1.0 — while the origin
 * dist-tags had already flipped to 2.2.0). The REST endpoint with a
 * timestamp query and no-store headers bypasses that.
 */
async function originDistTagsLatest() {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/-/package/${encodeURIComponent(name).replace("%40", "@")}/dist-tags?t=${Date.now()}`,
      { headers: { accept: "application/json", "cache-control": "no-store" } }
    );
    if (!response.ok) return null;
    const tags = await response.json();
    return typeof tags.latest === "string" ? tags.latest : null;
  } catch {
    return null;
  }
}

function combinedOutput(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function runPublish(label, { command, args, env }) {
  console.log(`Publishing ${name}@${version} via ${label}...`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

// Prefer provenance: npm signs an attestation linking this tarball to the
// repository and commit. If attestation cannot be produced (sigstore/registry
// hiccup) still try without, but say so loudly instead of silently shipping
// an unsigned package.
function publishWithProvenanceFallback(attempt) {
  const withProvenance = {
    ...attempt,
    args: [...attempt.args, "--provenance"],
  };
  let result = runPublish(`${attempt.label} --provenance`, withProvenance);
  if (
    result.status !== 0 &&
    /provenance|attestation|sigstore/i.test(combinedOutput(result))
  ) {
    console.warn("[warn] publish --provenance failed; retrying WITHOUT provenance attestation");
    result = runPublish(attempt.label, attempt);
  }
  return result;
}

async function verifyLanded() {
  // npm publish exiting 0 is NOT proof the version landed: a dispatch-run
  // OIDC publish once exited 0 with full notices + provenance while the
  // registry packument was never modified (live incident, 2.0.3). The only
  // trustworthy success signal is the version being readable from the
  // registry afterwards. BUT the registry serves stale packuments for a
  // short window after a successful publish (live: v2.1.0's tag run failed
  // red here while dist-tags had already flipped) — poll briefly before
  // declaring failure.
  const VERIFY_ATTEMPTS = 9;
  const VERIFY_DELAY_MS = 10_000;
  let landed = null;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    landed = (await originDistTagsLatest()) ?? npmViewVersion();
    if (landed === version) break;
    if (attempt < VERIFY_ATTEMPTS) {
      console.log(`registry still reports ${landed ?? "no version"} (attempt ${attempt}/${VERIFY_ATTEMPTS}) — polling again in ${VERIFY_DELAY_MS / 1000}s...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, VERIFY_DELAY_MS);
    }
  }
  return landed;
}

async function main() {
  const published = npmViewVersion();
  if (published === version) {
    console.log(
      `${name}@${version} is already published on the registry. Skipping publish (idempotent success).`
    );
    process.exit(0);
  }

  console.log(
    `${name}@${version} is not on the registry yet (current: ${published ?? "no version / package missing"}).`
  );

  const token = resolveNpmToken(process.env);
  const oidc = hasGithubOidc(process.env);
  const attempts = [];

  if (oidc) {
    const dir = mkdtempSync(join(tmpdir(), "graphflow-npm-oidc-"));
    const npmrc = writeOidcNpmrc(join(dir, ".npmrc"));
    const argv = npmPublishArgv("oidc", { userconfig: npmrc });
    attempts.push({
      label: "GitHub OIDC trusted publishing",
      command: argv.command,
      args: argv.args,
      env: oidcPublishEnv(process.env, npmrc),
    });
  }

  if (token) {
    const argv = npmPublishArgv("token");
    attempts.push({
      label: "NODE_AUTH_TOKEN",
      command: argv.command,
      args: argv.args,
      env: process.env,
    });
  }

  if (attempts.length === 0) {
    console.error(
      "No npm auth available: set NPM_TOKEN / npm_token, or run this job with `id-token: write` and configure a Trusted Publisher on npmjs.com."
    );
    process.exit(1);
  }

  let sawEotp = false;
  let lastCombined = "";
  for (const attempt of attempts) {
    const result = publishWithProvenanceFallback(attempt);
    const combined = combinedOutput(result);
    lastCombined = combined;
    if (result.status === 0) {
      const landed = await verifyLanded();
      if (landed === version) {
        console.log(`Published ${name}@${version} successfully (${attempt.label}, verified on the registry).`);
        process.exit(0);
      }
      console.error(
        `npm publish exited 0 but the registry still reports ${landed ?? "no version"} after polling — ` +
          `the publish did NOT land. Failing loudly instead of a false green.`
      );
      process.exit(1);
    }

    const kind = classifyNpmPublishFailure(combined);
    if (kind === "already-published" || npmViewVersion() === version) {
      console.log(
        `${name}@${version} already exists on the registry (publish conflict). Treating as success (idempotent).`
      );
      process.exit(0);
    }
    if (kind === "eotp") {
      sawEotp = true;
      console.error(
        `${attempt.label} hit EOTP (token requires 2FA OTP, which CI cannot supply).`
      );
      continue;
    }
    if ((kind === "need-auth" || kind === "other") && attempts.indexOf(attempt) < attempts.length - 1) {
      console.error(
        `${attempt.label} failed (${kind}); trying the next auth method.`
      );
      continue;
    }
    break;
  }

  if (sawEotp) {
    console.error(formatEotpOperatorMessage());
  } else if (isOidcExchangeFailure(lastCombined)) {
    console.error(formatOidcExchangeFailureMessage());
  } else {
    console.error("npm publish failed with every configured auth method.");
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
