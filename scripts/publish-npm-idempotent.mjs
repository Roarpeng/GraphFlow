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

const publish = spawnSync("npm", ["publish", "--access", "public"], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});

if (publish.stdout) process.stdout.write(publish.stdout);
if (publish.stderr) process.stderr.write(publish.stderr);

if (publish.status === 0) {
  console.log(`Published ${name}@${version} successfully.`);
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
