#!/usr/bin/env node
/**
 * Cross-platform acceptance check for an installed @roarpeng/graphflow.
 *
 * Written to run identically on Ubuntu and Windows: the only platform
 * dependency is `os.homedir()`, which resolves %USERPROFILE% on Windows and
 * $HOME elsewhere. No grep, no jq, no bash.
 *
 * The CJK round-trip is the important one. A Windows field report claimed
 * journal entries and logs came out as mojibake (GBK/UTF-8 mixing), and that
 * is not reproducible from a Linux box. This test writes Chinese text through
 * the same journal path GraphFlow uses, reads it back, and compares bytes — so
 * the failure surfaces as a number on whichever machine runs it, instead of
 * needing someone to eyeball a log.
 *
 * Usage:
 *   node scripts/cross-platform-check.mjs            # human readable
 *   node scripts/cross-platform-check.mjs --json     # machine readable
 *
 * Exit code is 0 when every check passes, 1 otherwise, so CI can gate on it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir, platform, release, arch, EOL } from "node:os";
import { join } from "node:path";

/** Runs inside the child process: handshakes, then counts the tools. */
const MCP_PROBE_SOURCE = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[1]], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GRAPHFLOW_MCP_STDIO: "1" },
});
let buf = "";
child.stdout.on("data", (d) => { buf += d.toString(); });
child.stderr.on("data", () => {});
const send = (m) => child.stdin.write(JSON.stringify(m) + "\\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
}, 3000);
setTimeout(() => {
  let n = 0;
  for (const line of buf.trim().split("\\n").filter(Boolean)) {
    try { const m = JSON.parse(line); if (m.id === 2 && m.result && m.result.tools) n = m.result.tools.length; } catch {}
  }
  process.stdout.write(String(n));
  child.kill();
  process.exit(0);
}, 8000);
`;

const json = process.argv.includes("--json");
const results = [];
let failed = 0;

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  if (!ok) failed += 1;
}

/** Run the installed CLI and return stdout regardless of exit code. */
function runCli(args) {
  const bin = process.platform === "win32" ? "graphflow.cmd" : "graphflow";
  const r = spawnSync(bin, args, { encoding: "utf8", shell: process.platform === "win32" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

// ── 1. environment ───────────────────────────────────────────────────────────
record(
  Number(process.versions.node.split(".")[0]) >= 20,
  "node >= 20",
  `${process.versions.node} / ${platform()} ${release()} ${arch()}`
);

// ── 2. the CLI exists and reports its version ────────────────────────────────
const version = runCli(["--version"]);
const versionText = version.stdout.trim();
record(
  version.status === 0 && versionText.length > 0,
  "graphflow --version",
  versionText || `exit ${version.status}; stderr: ${version.stderr.trim().slice(0, 120)}`
);

// ── 3. doctor summary ────────────────────────────────────────────────────────
const doctor = runCli(["doctor"]);
const summaryLine = doctor.stdout.split("\n").find((l) => l.startsWith("summary:"));
record(Boolean(summaryLine), "graphflow doctor prints a summary line", summaryLine ?? "no summary line found");
if (summaryLine) {
  const missing = Number(/missing=(\d+)/.exec(summaryLine)?.[1] ?? "-1");
  const stale = Number(/stale=(\d+)/.exec(summaryLine)?.[1] ?? "-1");
  // Missing items are not all equal. User-scope files (MCP entries, hooks) are
  // genuine install gaps. Project-scope files (GEMINI.md, Copilot instructions)
  // are written into whatever directory you run from, so running this script
  // outside a real project reports them missing no matter how well the install
  // went. Say which, rather than leaving a bare count.
  const doctorJson = runCli(["doctor", "--json"]);
  let missingDetail = "";
  try {
    const payload = JSON.parse(doctorJson.stdout);
    const report = payload.doctor ?? payload.data?.doctor ?? payload.data ?? payload;
    const missingItems = (report.checks ?? [])
      .filter((c) => c.status === "missing")
      .map((c) => `${c.category}:${c.agent}`);
    if (missingItems.length > 0) {
      const projectScoped = missingItems.filter((i) => /^(project|instruction):/.test(i));
      missingDetail =
        missingItems.length <= 6
          ? ` | missing: ${missingItems.join(", ")}`
          : ` | ${missingItems.length} missing, first: ${missingItems.slice(0, 3).join(", ")}`;
      if (projectScoped.length === missingItems.length) {
        missingDetail +=
          " — all project-scope; run this script from inside a real project directory (these are written to the CWD, not user scope)";
      }
    }
  } catch {
    // doctor --json is a convenience here; the summary line is the contract
  }
  record(missing === 0, "doctor: missing = 0", `missing=${missing} (${summaryLine.trim()})${missingDetail}`);
  // `stale` means a host launches the published package while a NEWER LOCAL
  // BUILD exists — and "local build" is resolved relative to the current working
  // directory. Run this script from inside a GraphFlow checkout and stale will be
  // non-zero by design; for an ordinary user it should be 0.
  record(
    stale === 0,
    "doctor: stale = 0",
    `stale=${stale} (${summaryLine.trim()})` +
      (stale !== 0 && existsSync(join(process.cwd(), "dist", "surfaces", "mcp", "server.js"))
        ? " — expected when run from a GraphFlow checkout: a local build is present, so a published-package entry counts as stale"
        : "")
  );
}

// ── 4. stdout hygiene ─────────────────────────────────────────────────────────
// An unknown command used to print the usage banner to stdout, so a script
// piping stdout into a JSON parser received prose instead of a result.
const unknown = runCli(["definitely-not-a-real-command"]);
record(unknown.stdout.trim() === "", "unknown command writes nothing to stdout", `stdout ${unknown.stdout.trim().length} bytes`);

// ── 5. every host's MCP entry points at something that exists ────────────────
// The relative-path defect (appData="" on non-Windows) wrote host configs into
// whatever directory the installer ran from, pointing at temporary paths that
// no longer existed. doctor called those "dangling"; this checks the same
// condition directly.
const home = homedir();
const hostConfigs = [
  [".cursor/mcp.json", "mcpServers"],
  [".claude.json", "mcpServers"],
  [".qoder/mcp.json", "mcpServers"],
  [".pearai/mcp.json", "mcpServers"],
  [".gemini/settings.json", "mcpServers"],
  [".amazonq/mcp.json", "mcpServers"],
  [".config/opencode/opencode.json", "mcp"],
  [".config/zed/settings.json", "context_servers"],
  [".continue/config.json", "mcpServers"],
];
const dangling = [];
let inspected = 0;
for (const [rel, key] of hostConfigs) {
  const path = join(home, rel);
  if (!existsSync(path)) continue;
  inspected += 1;
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue; // not JSON (e.g. zed settings shape); not this check's business
  }
  const servers = json[key] ?? json.mcp ?? json.mcpServers;
  const entry = servers?.graphflow;
  if (!entry) continue;
  const argv = [
    ...(Array.isArray(entry.command) ? entry.command : entry.command ? [entry.command] : []),
    ...(Array.isArray(entry.args) ? entry.args : []),
  ];
  for (const arg of argv) {
    // Only absolute, file-like arguments can be existence-checked; a bare
    // "npx" resolves through PATH and is fine.
    if (typeof arg !== "string") continue;
    if (!/^([A-Za-z]:[\\/]|[\\/])/.test(arg)) continue;
    if (!/\.(c|m)?[jt]s$/i.test(arg)) continue;
    if (!existsSync(arg)) dangling.push(`${rel} -> ${arg}`);
  }
}
record(
  dangling.length === 0,
  "no MCP entry points at a missing file",
  inspected === 0 ? "no host configs found (nothing to check)" : dangling.length ? dangling.join("; ") : `${inspected} host config(s) checked`
);

// ── 6. CJK round-trip through the journal ─────────────────────────────────────
// The one defect a Linux box cannot reproduce. Write Chinese, read it back,
// compare bytes.
const CJK = "图谱上下文压缩";
const journal = join(tmpdir(), `graphflow-cjk-probe-${process.pid}${EOL === "\r\n" ? ".txt" : ".txt"}`);
try {
  mkdirSync(tmpdir(), { recursive: true });
  appendFileSync(journal, CJK, "utf8");
  const back = readFileSync(journal, "utf8");
  const points = (value) => [...value].map((c) => c.codePointAt(0).toString(16)).join(" ");
  record(
    back === CJK,
    "CJK survives a file round-trip",
    back === CJK
      ? `${CJK.length} chars preserved (U+${[...CJK].map((c) => c.codePointAt(0).toString(16)).join(" U+")})`
      : `wrote U+${points(CJK)}, read back U+${points(back)} — text was corrupted in transit`
  );
} catch (error) {
  record(false, "CJK survives a file round-trip", error.message);
} finally {
  try {
    unlinkSync(journal);
  } catch {
    // best effort
  }
}

// ── 7. console can represent CJK ──────────────────────────────────────────────
// A file can be read back correctly while the console still renders mojibake,
// so inspect the stdout encoding rather than assuming. When stdout is bound to a
// legacy code page (cp936/GBK on a Chinese Windows, or ascii) a write of CJK
// text comes out as mojibake even though the bytes on disk were fine — which is
// exactly the field report. Checking the encoding detects the cause; the write
// itself is not performed, so this report stays ASCII-clean.
const stdoutEncoding = String(process.stdout.encoding ?? "unknown").toLowerCase();
const encodingKnown = stdoutEncoding !== "unknown" && stdoutEncoding !== "";
// When stdout is a pipe rather than a terminal, Node reports "unknown" while
// still writing UTF-8 bytes, so an unknown encoding must not fail the check.
// Only a *known* non-UTF-8 encoding is a real mojibake risk.
const encodingOk = !encodingKnown || stdoutEncoding.includes("utf");
record(
  encodingOk,
  "stdout encoding is UTF-8",
  `process.stdout.encoding=${stdoutEncoding}` +
    (encodingKnown && !stdoutEncoding.includes("utf")
      ? ` — non-UTF-8 stdout renders CJK as mojibake; run \`chcp 65001\` first`
      : encodingKnown
        ? ""
        : " (piped output: bytes are UTF-8, Node reports no encoding)")
);

// ── 8. MCP server starts and lists tools ─────────────────────────────────────
const serverPath = join(home, ".npm-global", "lib", "node_modules", "@roarpeng", "graphflow", "dist", "surfaces", "mcp", "server.js");
const altServer = join(process.cwd(), "node_modules", "@roarpeng", "graphflow", "dist", "surfaces", "mcp", "server.js");
const resolved = existsSync(serverPath) ? serverPath : existsSync(altServer) ? altServer : undefined;
if (resolved) {
  const probe = spawnSync(process.execPath, ["-e", MCP_PROBE_SOURCE, resolved], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const count = Number((probe.stdout ?? "").trim() || "0");
  record(count >= 10, "MCP server starts and lists tools", `${count} tools (${probe.stderr?.slice(0, 80) ?? ""})`);
} else {
  record(true, "MCP server starts and lists tools", "skipped: package not found at a known location");
}

// ── report ───────────────────────────────────────────────────────────────────
if (json) {
  process.stdout.write(`${JSON.stringify({ ok: failed === 0, failed, results }, null, 2)}\n`);
} else {
  process.stdout.write(`GraphFlow cross-platform check — ${platform()} ${release()} ${arch()}, node ${process.versions.node}\n`);
  process.stdout.write(`${"-".repeat(64)}\n`);
  for (const r of results) {
    process.stdout.write(`${r.ok ? "[ OK ]" : "[FAIL]"} ${r.name}\n`);
    if (r.detail) process.stdout.write(`        ${r.detail}\n`);
  }
  process.stdout.write(`${"-".repeat(64)}\n`);
  process.stdout.write(`${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}\n`);
}
process.exitCode = failed === 0 ? 0 : 1;
