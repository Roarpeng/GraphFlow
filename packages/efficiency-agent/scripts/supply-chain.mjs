#!/usr/bin/env node
// Supply-chain artifacts for the efficiency-agent package (spec §20): answers
// "which commit built this artifact, with which dependencies and build
// parameters, and how do I verify it?". Writes to packages/efficiency-agent/artifacts/:
//   <name>-<version>.tgz   npm pack output
//   SHA256SUMS             sha256sum-compatible checksum of the tarball
//   sbom.cdx.json          CycloneDX SBOM (npm sbom, or a lockfile-derived fallback)
//   provenance.json        commit, dirty flag, toolchain, build command, dependency pins
//
// Usage: node packages/efficiency-agent/scripts/supply-chain.mjs [--no-build] [--json]

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "./secret-scan.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");
const PKG_REL = "packages/efficiency-agent";
const artifactsDir = join(packageDir, "artifacts");

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const json = args.includes("--json");
const log = (msg) => (json ? process.stderr : process.stdout).write(`${msg}\n`);

const FORBIDDEN_IN_TARBALL = [
  { re: /(^|\/)graphflow-out\//, why: "local GraphFlow state (graphflow-out/)" },
  { re: /(^|\/)\.graphflow(-cache)?\//, why: "local GraphFlow cache" },
  { re: /(^|\/)artifacts\//, why: "build artifacts directory" },
  { re: /(^|\/)\.env(\.[^/]*)?$/, why: "dotenv file" },
  { re: /\.(pem|key|p12|pfx)$/i, why: "key material" },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/, why: "ssh key" },
  { re: /(^|\/)\.npmrc$/, why: "npm credentials file" },
  { re: /(^|\/)node_modules\//, why: "node_modules" },
];

/** npm is a .cmd shim on Windows; it needs a shell there (Node >= 20.12). */
function npm(npmArgs, cwd) {
  const quoted = npmArgs.map((a) => (/[\s"&|<>^]/.test(a) ? JSON.stringify(a) : a));
  return spawnSync("npm", quoted, { cwd, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function git(gitArgs) {
  const res = spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function die(msg, extra) {
  process.stderr.write(`supply-chain: ${msg}\n`);
  if (extra) process.stderr.write(`${extra.trim().split(/\r?\n/).slice(-20).join("\n")}\n`);
  process.exit(1);
}

function sha(alg, file) {
  return createHash(alg).update(readFileSync(file)).digest();
}

// ---------------------------------------------------------------- lockfile closure

function readLock() {
  const p = join(repoRoot, "package-lock.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Resolve `name` from lockfile location `from` using node_modules lookup semantics. */
function resolveInLock(packages, from, name) {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const idx = base.lastIndexOf("/node_modules/");
    base = idx >= 0 ? base.slice(0, idx) : "";
  }
}

/** Production dependency closure of the workspace package, with pinned versions. */
function productionClosure(lock, rootDeps) {
  if (!lock?.packages) return { deps: [], unresolved: Object.keys(rootDeps) };
  const packages = lock.packages;
  const seen = new Map();
  const unresolved = [];
  const queue = Object.keys(rootDeps).map((name) => ({ from: PKG_REL, name, optional: false }));
  while (queue.length) {
    const { from, name, optional } = queue.shift();
    let key = resolveInLock(packages, from, name);
    if (!key) {
      if (!optional) unresolved.push(name);
      continue;
    }
    let entry = packages[key];
    if (entry.link && entry.resolved) {
      key = entry.resolved;
      entry = packages[key] ?? entry;
    }
    if (seen.has(key)) continue;
    seen.set(key, {
      name: entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
      version: entry.version ?? null,
      integrity: entry.integrity ?? null,
      resolved: entry.resolved ?? null,
      license: entry.license ?? null,
    });
    for (const d of Object.keys(entry.dependencies ?? {})) queue.push({ from: key, name: d, optional: false });
    for (const d of Object.keys(entry.optionalDependencies ?? {})) queue.push({ from: key, name: d, optional: true });
    // Peers are pinned when the lockfile installed them; an absent peer is the host's choice.
    for (const d of Object.keys(entry.peerDependencies ?? {})) queue.push({ from: key, name: d, optional: true });
  }
  const deps = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  return { deps, unresolved: [...new Set(unresolved)] };
}

function purl(name, version) {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

function integrityToHashes(integrity) {
  if (!integrity) return [];
  return integrity
    .split(/\s+/)
    .map((sri) => {
      const m = /^(sha1|sha256|sha384|sha512)-(.+)$/.exec(sri);
      if (!m) return null;
      const alg = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[m[1]];
      return { alg, content: Buffer.from(m[2], "base64").toString("hex") };
    })
    .filter(Boolean);
}

function fallbackSbom(pkg, closure, tarballSha256) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: "application", name: "graphflow-efficiency-agent/supply-chain.mjs", version: pkg.version }] },
      component: {
        type: "library",
        "bom-ref": purl(pkg.name, pkg.version),
        name: pkg.name,
        version: pkg.version,
        purl: purl(pkg.name, pkg.version),
        hashes: tarballSha256 ? [{ alg: "SHA-256", content: tarballSha256 }] : [],
      },
    },
    components: closure.deps.map((d) => ({
      type: "library",
      "bom-ref": purl(d.name, d.version),
      name: d.name,
      version: d.version,
      purl: purl(d.name, d.version),
      hashes: integrityToHashes(d.integrity),
      ...(d.license ? { licenses: [{ expression: d.license }] } : {}),
      ...(d.resolved ? { externalReferences: [{ type: "distribution", url: d.resolved }] } : {}),
    })),
  };
}

// ---------------------------------------------------------------- main

const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
mkdirSync(artifactsDir, { recursive: true });
for (const f of readdirSync(artifactsDir)) {
  if (f.endsWith(".tgz") || f === "SHA256SUMS" || f === "sbom.cdx.json" || f === "provenance.json") {
    rmSync(join(artifactsDir, f), { force: true });
  }
}

// 1. build (dist/ is what main/bin point at)
const buildCommand = noBuild
  ? "npm pack --json --ignore-scripts --pack-destination artifacts"
  : "npm run build && npm pack --json --ignore-scripts --pack-destination artifacts";
if (!noBuild) {
  log("supply-chain: npm run build");
  const b = npm(["run", "build"], packageDir);
  if (b.status !== 0) die(`build failed (exit ${b.status})`, `${b.stdout}${b.stderr}`);
}

// 2. npm pack
log("supply-chain: npm pack");
const packed = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", artifactsDir], packageDir);
if (packed.status !== 0) die(`npm pack failed (exit ${packed.status})`, `${packed.stdout}${packed.stderr}`);
let packInfo;
try {
  const starts = [packed.stdout.indexOf("["), packed.stdout.indexOf("{")].filter((i) => i >= 0);
  const parsed = JSON.parse(packed.stdout.slice(Math.min(...starts)));
  // npm <= 10 prints an array; npm >= 11 in a workspace prints { "<name>": {...} }.
  packInfo = Array.isArray(parsed) ? parsed[0] : parsed.filename ? parsed : parsed[pkg.name] ?? Object.values(parsed)[0];
  if (!packInfo?.filename) throw new Error("no filename in pack result");
} catch (err) {
  die(`could not parse npm pack --json output: ${err.message}`, packed.stdout);
}
const tarballName = packInfo.filename.replace(/^@/, "").replace(/\//g, "-");
const tarball = join(artifactsDir, tarballName);
if (!existsSync(tarball)) die(`npm pack reported ${packInfo.filename} but ${tarball} does not exist`);

// 3. tarball hygiene: no local state, no key material, no secrets in packed files
const files = (packInfo.files ?? []).map((f) => f.path.replace(/\\/g, "/"));
const problems = [];
for (const f of files) {
  for (const rule of FORBIDDEN_IN_TARBALL) if (rule.re.test(f)) problems.push(`${f}: ${rule.why}`);
  const abs = join(packageDir, f);
  if (existsSync(abs) && statSync(abs).size < 2 * 1024 * 1024) {
    for (const hit of scanText(readFileSync(abs, "utf8"), f)) problems.push(`${hit.file}:${hit.line}: ${hit.rule} ${hit.masked}`);
  }
}
if (!files.some((f) => f === "dist/index.js")) problems.push("dist/index.js missing from tarball (main entry)");
if (!files.some((f) => f === "dist/bin/eff-agent.js")) problems.push("dist/bin/eff-agent.js missing from tarball (bin entry)");
if (problems.length) {
  rmSync(tarball, { force: true });
  die(`tarball rejected (${problems.length} problem(s)); removed ${tarballName}`, problems.join("\n"));
}

// 4. checksums, verified against npm's own integrity
const sha256 = sha("sha256", tarball).toString("hex");
const sha512Sri = `sha512-${sha("sha512", tarball).toString("base64")}`;
if (packInfo.integrity && packInfo.integrity !== sha512Sri) {
  die(`tarball sha512 ${sha512Sri} does not match npm pack integrity ${packInfo.integrity}`);
}
writeFileSync(join(artifactsDir, "SHA256SUMS"), `${sha256}  ${tarballName}\n`);

// 5. SBOM
const lock = readLock();
const closure = productionClosure(lock, pkg.dependencies ?? {});
const sbomFile = "sbom.cdx.json";
let sbomSource = "npm sbom";
const forceFallback = process.env.EFF_SBOM_FORCE_FALLBACK === "1";
const sb = forceFallback
  ? { status: 1, stdout: "", stderr: "error: EFF_SBOM_FORCE_FALLBACK=1" }
  : npm(["sbom", "--sbom-format", "cyclonedx", "--omit", "dev", "--workspace", PKG_REL], repoRoot);
let sbom = null;
if (sb.status === 0) {
  try {
    sbom = JSON.parse(sb.stdout);
    if (sbom.bomFormat !== "CycloneDX") sbom = null;
  } catch {
    sbom = null;
  }
}
if (!sbom) {
  const why = (sb.stderr || sb.stdout || "").split(/\r?\n/).find((l) => /error|ERR!/i.test(l)) ?? `exit ${sb.status}`;
  sbomSource = `fallback (lockfile-derived CycloneDX 1.5; npm sbom unavailable: ${why.trim().slice(0, 160)})`;
  sbom = fallbackSbom(pkg, closure, sha256);
}
writeFileSync(join(artifactsDir, sbomFile), `${JSON.stringify(sbom, null, 2)}\n`);

// 6. provenance
const porcelain = git(["status", "--porcelain"]);
const porcelainPkg = git(["status", "--porcelain", "--", PKG_REL]);
const npmVersion = npm(["--version"], repoRoot).stdout?.trim() || null;
const provenance = {
  schema: "eff-agent-provenance/v1",
  package: { name: pkg.name, version: pkg.version },
  commit: git(["rev-parse", "HEAD"]),
  ref: process.env.GITHUB_REF ?? git(["rev-parse", "--abbrev-ref", "HEAD"]),
  dirty: porcelain === null ? null : porcelain.length > 0,
  dirtyPackage: porcelainPkg === null ? null : porcelainPkg.length > 0,
  builtAt: new Date().toISOString(),
  node: process.version,
  npm: npmVersion,
  platform: `${process.platform}-${process.arch}`,
  ci: process.env.GITHUB_ACTIONS === "true"
    ? { runId: process.env.GITHUB_RUN_ID ?? null, workflow: process.env.GITHUB_WORKFLOW ?? null, repository: process.env.GITHUB_REPOSITORY ?? null }
    : null,
  buildCommand,
  tarball: tarballName,
  sha256,
  integrity: sha512Sri,
  fileCount: files.length,
  unpackedSize: packInfo.unpackedSize ?? null,
  dependencies: closure.deps.map(({ name, version, integrity }) => ({ name, version, integrity })),
  unresolvedDependencies: closure.unresolved,
  sbomFile,
  sbomSource,
  verify: `sha256sum -c SHA256SUMS  (in ${PKG_REL}/artifacts)`,
};
writeFileSync(join(artifactsDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

const summary = {
  tarball: `${PKG_REL}/artifacts/${tarballName}`,
  files: files.length,
  sha256,
  sbom: sbomSource,
  dependencies: closure.deps.length,
  unresolved: closure.unresolved,
  commit: provenance.commit,
  dirty: provenance.dirty,
};
if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
else {
  log(`supply-chain: ${tarballName} (${files.length} files, sha256 ${sha256.slice(0, 16)}...)`);
  log(`supply-chain: SBOM ${sbomSource}; ${closure.deps.length} production deps pinned${closure.unresolved.length ? `, unresolved: ${closure.unresolved.join(", ")}` : ""}`);
  log(`supply-chain: commit ${provenance.commit ?? "unknown"}${provenance.dirty ? " (dirty worktree)" : ""}; wrote SHA256SUMS, ${sbomFile}, provenance.json`);
}
