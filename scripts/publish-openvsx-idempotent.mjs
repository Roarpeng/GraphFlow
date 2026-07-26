#!/usr/bin/env node
/**
 * Idempotent Open VSX publish for CI.
 * If the extension version is already on open-vsx.org, exit 0.
 *
 * Env:
 *   open_vsx_token | OPEN_VSX_TOKEN | OVSX_PAT — personal access token
 *   OVSX_NAMESPACE   — Open VSX namespace (default: graphflow)
 *   OVSX_REGISTRY_URL — optional registry base (default https://open-vsx.org)
 *   OVSX_VSIX         — optional path to a prebuilt .vsix; otherwise packages first
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const {
  resolveOpenVsxToken,
  openVsxHasVersion,
  alignPackageJsonForNamespace,
} = require("./openvsx-publish-lib.cjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "vscode-extension");
const packageJsonPath = join(extensionDir, "package.json");
const packageJsonBackupPath = join(extensionDir, "package.json.openvsx-backup");
const registryUrl = (process.env.OVSX_REGISTRY_URL || "https://open-vsx.org").replace(/\/$/, "");

export { resolveOpenVsxToken, openVsxHasVersion, alignPackageJsonForNamespace };

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

function readExtensionPackage() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function resolveVsixPath(version) {
  if (process.env.OVSX_VSIX) {
    return process.env.OVSX_VSIX;
  }
  const artifactsDir = join(root, "artifacts");
  const preferred = join(artifactsDir, `graphflow-tool-${version}.vsix`);
  if (existsSync(preferred)) {
    return preferred;
  }
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

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
  });
}

function publishWithOvsx(vsixPath, token) {
  const args = ["--yes", "ovsx", "publish", vsixPath, "--pat", token];
  return run("npx", args, root);
}

function packageExtension() {
  const build = run("npm", ["run", "build"], root);
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.status !== 0) {
    return build;
  }
  const pack = run("npm", ["run", "package:extension"], root);
  if (pack.stdout) process.stdout.write(pack.stdout);
  if (pack.stderr) process.stderr.write(pack.stderr);
  return pack;
}

function restorePackageJson() {
  if (!existsSync(packageJsonBackupPath)) {
    return;
  }
  copyFileSync(packageJsonBackupPath, packageJsonPath);
  unlinkSync(packageJsonBackupPath);
}

async function main() {
  const token = resolveOpenVsxToken();
  if (!token) {
    console.error(
      "Open VSX token is required. Set repository secret open_vsx_token (mapped to env open_vsx_token / OPEN_VSX_TOKEN / OVSX_PAT)."
    );
    process.exit(1);
  }

  const pkg = readExtensionPackage();
  const name = pkg.name;
  const version = pkg.version;
  const namespace = process.env.OVSX_NAMESPACE || "graphflow";
  let patched = false;

  console.log(`Checking Open VSX for ${namespace}.${name}@${version} via ${registryUrl}...`);
  let metadata;
  try {
    metadata = await fetchOpenVsxMetadata(registryUrl, namespace, name);
  } catch (error) {
    console.warn(
      `Warning: could not query Open VSX metadata (${error instanceof Error ? error.message : error}). Continuing with publish.`
    );
    metadata = null;
  }

  if (openVsxHasVersion(metadata, version)) {
    console.log(
      `${namespace}.${name}@${version} is already published on Open VSX. Skipping publish (idempotent success).`
    );
    return;
  }

  let exitCode = 0;
  try {
    if (pkg.publisher !== namespace) {
      console.log(
        `Aligning package publisher "${pkg.publisher}" -> Open VSX namespace "${namespace}" for this publish only.`
      );
      copyFileSync(packageJsonPath, packageJsonBackupPath);
      const aligned = alignPackageJsonForNamespace(pkg, namespace);
      writeFileSync(packageJsonPath, `${JSON.stringify(aligned, null, 2)}\n`, "utf8");
      patched = true;
    }

    let vsixPath = resolveVsixPath(version);
    if (!vsixPath || patched) {
      console.log("Packaging extension for Open VSX...");
      const packed = packageExtension();
      if (packed.status !== 0) {
        console.error(`Extension packaging failed with exit code ${packed.status ?? 1}`);
        exitCode = packed.status ?? 1;
        return;
      }
      vsixPath = resolveVsixPath(version);
    }

    if (!vsixPath || !existsSync(vsixPath)) {
      console.error("No VSIX found under artifacts/ after packaging.");
      exitCode = 1;
      return;
    }

    console.log(`Publishing VSIX to Open VSX namespace ${namespace}: ${vsixPath}`);
    const publish = publishWithOvsx(vsixPath, token);
    if (publish.stdout) process.stdout.write(publish.stdout);
    if (publish.stderr) process.stderr.write(publish.stderr);

    if (publish.status === 0) {
      console.log(`Published ${namespace}.${name}@${version} to Open VSX successfully.`);
      return;
    }

    const combined = `${publish.stdout || ""}\n${publish.stderr || ""}`;
    const alreadyPublished =
      /already\s+(exists|published)/i.test(combined) ||
      /version\s+already/i.test(combined) ||
      /is already published/i.test(combined);

    if (alreadyPublished) {
      console.log(
        `${namespace}.${name}@${version} already exists on Open VSX (publish conflict). Treating as success (idempotent).`
      );
      return;
    }

    console.error(`Open VSX publish failed with exit code ${publish.status ?? 1}`);
    exitCode = publish.status ?? 1;
  } finally {
    if (patched) {
      restorePackageJson();
    }
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("Open VSX publish failed:", error);
    if (existsSync(packageJsonBackupPath)) {
      restorePackageJson();
    }
    process.exit(1);
  });
}
