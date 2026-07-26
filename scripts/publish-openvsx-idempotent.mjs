#!/usr/bin/env node
/**
 * Idempotent Open VSX publish for CI.
 * If the extension version is already on open-vsx.org, exit 0.
 *
 * Env:
 *   OVSX_PAT          — required personal access token
 *   OVSX_REGISTRY_URL — optional registry base (default https://open-vsx.org)
 *   OVSX_VSIX         — optional path to a prebuilt .vsix; otherwise publishes from vscode-extension/
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "vscode-extension");
const pkg = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
const publisher = pkg.publisher;
const name = pkg.name;
const version = pkg.version;
const registryUrl = (process.env.OVSX_REGISTRY_URL || "https://open-vsx.org").replace(/\/$/, "");

export function openVsxHasVersion(metadata, targetVersion) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  if (metadata.version === targetVersion) {
    return true;
  }
  const all = metadata.allVersions;
  return Boolean(all && typeof all === "object" && all[targetVersion]);
}

export async function fetchOpenVsxMetadata(baseUrl, ns, ext) {
  const url = `${baseUrl}/api/${encodeURIComponent(ns)}/${encodeURIComponent(ext)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Open VSX metadata request failed: HTTP ${response.status} ${url}`);
  }
  return response.json();
}

function resolveVsixPath() {
  if (process.env.OVSX_VSIX) {
    return process.env.OVSX_VSIX;
  }
  const artifactsDir = join(root, "artifacts");
  if (!existsSync(artifactsDir)) {
    return null;
  }
  const matches = readdirSync(artifactsDir)
    .filter((file) => file.startsWith("graphflow-tool-") && file.endsWith(".vsix"))
    .sort();
  if (matches.length === 0) {
    return null;
  }
  return join(artifactsDir, matches[matches.length - 1]);
}

function publishWithOvsx(vsixPath, token) {
  const args = ["--yes", "ovsx", "publish"];
  if (vsixPath) {
    args.push(vsixPath);
  }
  args.push("--pat", token);
  return spawnSync("npx", args, {
    cwd: vsixPath ? root : extensionDir,
    encoding: "utf8",
    env: process.env,
  });
}

async function main() {
  const token = process.env.OVSX_PAT;
  if (!token) {
    console.error("OVSX_PAT is required to publish to Open VSX.");
    process.exit(1);
  }

  console.log(`Checking Open VSX for ${publisher}.${name}@${version} via ${registryUrl}...`);
  let metadata;
  try {
    metadata = await fetchOpenVsxMetadata(registryUrl, publisher, name);
  } catch (error) {
    console.warn(
      `Warning: could not query Open VSX metadata (${error instanceof Error ? error.message : error}). Continuing with publish.`
    );
    metadata = null;
  }

  if (openVsxHasVersion(metadata, version)) {
    console.log(
      `${publisher}.${name}@${version} is already published on Open VSX. Skipping publish (idempotent success).`
    );
    process.exit(0);
  }

  const vsixPath = resolveVsixPath();
  if (vsixPath) {
    console.log(`Publishing prebuilt VSIX: ${vsixPath}`);
  } else {
    console.log(`No prebuilt VSIX found; publishing from ${extensionDir} via ovsx package+upload.`);
  }

  const publish = publishWithOvsx(vsixPath, token);
  if (publish.stdout) process.stdout.write(publish.stdout);
  if (publish.stderr) process.stderr.write(publish.stderr);

  if (publish.status === 0) {
    console.log(`Published ${publisher}.${name}@${version} to Open VSX successfully.`);
    process.exit(0);
  }

  const combined = `${publish.stdout || ""}\n${publish.stderr || ""}`;
  const alreadyPublished =
    /already\s+(exists|published)/i.test(combined) ||
    /version\s+already/i.test(combined) ||
    /is already published/i.test(combined);

  if (alreadyPublished) {
    console.log(
      `${publisher}.${name}@${version} already exists on Open VSX (publish conflict). Treating as success (idempotent).`
    );
    process.exit(0);
  }

  console.error(`Open VSX publish failed with exit code ${publish.status ?? 1}`);
  process.exit(publish.status ?? 1);
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("Open VSX publish failed:", error);
    process.exit(1);
  });
}
