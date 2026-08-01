#!/usr/bin/env node
/**
 * CI release-quality gate: assert the package version is consistent across
 * package.json, the latest CHANGELOG.md heading, and the README badge.
 *
 * Plain Node, zero dependencies, regex-based extraction so it can run without
 * `npm install`. Exits non-zero on any mismatch.
 */
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

function fail(message) {
  console.error(`[ci-version-check] FAIL: ${message}`);
  process.exitCode = 1;
}

function readFile(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    fail(`missing file: ${relativePath}`);
    return null;
  }
  return fs.readFileSync(fullPath, "utf8");
}

// --- package.json version ---------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const pkgVersion = pkg.version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(pkgVersion))) {
  fail(`package.json "version" is not a valid semver string: ${pkgVersion}`);
}

// --- CHANGELOG.md latest heading version ------------------------------------

const changelog = readFile("CHANGELOG.md");
let changelogVersion = null;
if (changelog !== null) {
  const match = changelog.match(/^## \[(\d[^\]]*)\]/m);
  if (match) {
    changelogVersion = match[1].trim();
  } else {
    fail("no version heading of the form '## [X.Y.Z]' found in CHANGELOG.md");
  }
}

// --- README.md badge version -------------------------------------------------

const readme = readFile("README.md");
let readmeVersion = null;
if (readme !== null) {
  const badgeMatch = readme.match(/badge\/npm-([0-9][^-\s)]*)/);
  if (badgeMatch) {
    readmeVersion = badgeMatch[1];
  } else {
    fail("no npm version badge (shields.io 'badge/npm-...') found in README.md");
  }
}

// --- compare ----------------------------------------------------------------

const problems = [];
if (changelogVersion !== null && changelogVersion !== pkgVersion) {
  problems.push(
    `CHANGELOG.md latest heading is [${changelogVersion}] but package.json is ${pkgVersion}`,
  );
}
if (readmeVersion !== null && readmeVersion !== pkgVersion) {
  problems.push(
    `README.md badge shows ${readmeVersion} but package.json is ${pkgVersion}`,
  );
}

for (const problem of problems) {
  fail(problem);
}

if (process.exitCode) {
  console.error(`[ci-version-check] versions must match: package.json=${pkgVersion} CHANGELOG=${changelogVersion ?? "n/a"} README=${readmeVersion ?? "n/a"}`);
} else {
  console.log(`[ci-version-check] OK: package.json / CHANGELOG.md / README.md all at ${pkgVersion}`);
}
