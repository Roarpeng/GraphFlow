#!/usr/bin/env node
/**
 * Idempotent npm publish for CI.
 * If the package version is already on the registry (or publish returns E403
 * "cannot publish over the previously published versions"), exit 0.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

async function main() {
const published = npmViewVersion();
if (published === version) {
  console.log(
    `${name}@${version} is already published on the registry. Skipping publish (idempotent success).`
  );
  process.exit(0);
}

console.log(
  `Publishing ${name}@${version} (registry currently has ${published ?? "no version / package missing"})...`
);

function runPublish(extraArgs) {
  return spawnSync("npm", ["publish", "--access", "public", ...extraArgs], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
}

// Prefer provenance: npm signs an attestation linking this tarball to the
// repository and commit (requires `id-token: write`, which the workflow grants).
// If attestation cannot be produced (sigstore/registry hiccup) we still publish,
// but say so loudly instead of silently shipping an unsigned package.
let publish = runPublish(["--provenance"]);
if (
  publish.status !== 0 &&
  /provenance|attestation|sigstore/i.test(`${publish.stdout ?? ""}\n${publish.stderr ?? ""}`)
) {
  console.warn("[warn] publish --provenance failed; retrying WITHOUT provenance attestation");
  if (publish.stdout) process.stdout.write(publish.stdout);
  if (publish.stderr) process.stderr.write(publish.stderr);
  publish = runPublish([]);
}

if (publish.stdout) process.stdout.write(publish.stdout);
if (publish.stderr) process.stderr.write(publish.stderr);

if (publish.status === 0) {
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
  if (landed !== version) {
    console.error(
      `npm publish exited 0 but the registry still reports ${landed ?? "no version"} after ${VERIFY_ATTEMPTS} attempts — ` +
        `the publish did NOT land. Failing loudly instead of a false green.`
    );
    process.exit(1);
  }
  console.log(`Published ${name}@${version} successfully (verified on the registry).`);
  process.exit(0);
}

const combined = `${publish.stdout || ""}\n${publish.stderr || ""}`;
const alreadyPublished =
  /E403/.test(combined) &&
  /cannot publish over the previously published versions/i.test(combined);

if (alreadyPublished || npmViewVersion() === version) {
  console.log(
    `${name}@${version} already exists on the registry (publish conflict). Treating as success (idempotent).`
  );
  process.exit(0);
}

console.error(`npm publish failed with exit code ${publish.status ?? 1}`);
process.exit(publish.status ?? 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
