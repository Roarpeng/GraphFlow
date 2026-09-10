#!/usr/bin/env node
/**
 * Idempotent npm publish for CI.
 *
 * Auth order:
 *   1. GitHub OIDC Trusted Publishing (no NODE_AUTH_TOKEN, npm >= 11.5.1)
 *   2. NODE_AUTH_TOKEN / NPM_TOKEN (fails with EOTP if the token requires 2FA)
 *
 * If the package version is already on the registry (or publish returns E403
 * "cannot publish over the previously published versions"), exit 0.
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
for (const attempt of attempts) {
  const result = runPublish(attempt.label, attempt);
  if (result.status === 0) {
    console.log(`Published ${name}@${version} successfully (${attempt.label}).`);
    process.exit(0);
  }

  const combined = combinedOutput(result);
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
  if (sawEotp || kind === "eotp") {
    console.error(formatEotpOperatorMessage());
  } else {
    console.error(`npm publish failed with exit code ${result.status ?? 1}`);
  }
  process.exit(result.status ?? 1);
}

if (sawEotp) {
  console.error(formatEotpOperatorMessage());
}
console.error("npm publish failed with every configured auth method.");
process.exit(1);
