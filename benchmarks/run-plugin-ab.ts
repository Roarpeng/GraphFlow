/**
 * Plugin ON vs plugin OFF token A/B (SoL-Pi paired-efficiency harness).
 *
 * Answers one question with a capability floor: does running the GraphFlow
 * plugin make an agent spend fewer tokens to finish the same task, without
 * doing less work?
 *
 * Modes:
 *  - micro   (default) offline + deterministic. Feeds real over-budget tool
 *            results (large source files) through the exact host projection
 *            contract (src/observations/host-hook.ts) and compares
 *            first-insertion tokens with/without ObservationPack. Verifies
 *            every archived handle recalls byte-exactly, so the saving is not
 *            information loss.
 *  - session reads provider-reported token usage for two real DSH runs
 *            (plugin profile vs baseline profile) from the session projection
 *            cache and turns them into one paired comparison.
 *  - plan    prints the exact two-run protocol without running anything.
 *
 * The paired comparison is produced by src/learning/efficiency-report.ts, the
 * same code the governance release gate reads, so a passed run is not a
 * bespoke number.
 *
 * Run:  npm run benchmark:plugin-ab
 *       npm run benchmark:plugin-ab -- --mode plan
 *       npm run benchmark:plugin-ab -- --mode session \
 *         --baseline-session <id> --packaged-session <id> --record
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/model/gpt-4o";

import { getDefaultConfig } from "../src/config/defaults.js";
import { redactSecrets } from "../src/learning/dialogue-thread.js";
import { recordEfficiencyComparison } from "../src/learning/efficiency-report.js";
import { projectToolResult } from "../src/observations/host-hook.js";
import { DEFAULT_OBSERVATION_POLICY, recallObservation } from "../src/observations/index.js";
import {
  dshProjcachePath,
  parseDshProjcacheUsage,
  summarizeAb,
  usageToArm,
  type AbArm,
  type UsageTokenMetric,
} from "./plugin-ab-lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CACHE_DIR = join(__dirname, ".cache");
const JSON_PATH = join(CACHE_DIR, "plugin-ab-results.json");
const SRC_DIR = join(REPO_ROOT, "src");
const DEFAULT_FILE_COUNT = 8;

function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function getCommitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim() || "unknown";
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const raw = readFlag(args, flag);
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** The largest `*.ts` files under src/, i.e. the tool results an agent reads whole. */
function largestSourceFiles(limit: number): string[] {
  const files: Array<{ path: string; size: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push({ path: full, size: statSync(full).size });
      }
    }
  };
  walk(SRC_DIR);
  return files
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((file) => file.path);
}

function benchmarkConfig() {
  const base = getDefaultConfig();
  return { ...base, graphPolicy: { ...base.graphPolicy, workspaceRoot: REPO_ROOT } };
}

interface MicroResult {
  mode: "micro";
  generatedAt: string;
  commit: string;
  fileCount: number;
  archivedCount: number;
  redactedCount: number;
  fidelityExact: boolean;
  baselineTokens: number;
  packagedTokens: number;
  savedTokens: number;
  savingsRatio: number;
  breakEvenFullRecalls: number | null;
  files: Array<{ path: string; bytes: number; baselineTokens: number; packagedTokens: number; archived: boolean; redacted: boolean }>;
}

async function runMicro(args: string[]): Promise<MicroResult> {
  const limit = readNumberFlag(args, "--files") ?? DEFAULT_FILE_COUNT;
  const record = hasFlag(args, "--record");
  // The production default redacts secrets on store, so recall is byte-exact to
  // the STORED bytes, not the caller's raw text. --raw-store disables that
  // transform to prove the archive itself is lossless.
  const rawStore = hasFlag(args, "--raw-store");
  const policy = rawStore ? { redactOnStore: false } : undefined;
  const redactsOnStore = rawStore ? false : DEFAULT_OBSERVATION_POLICY.redactOnStore;
  const paths = largestSourceFiles(limit);
  const packRoot = REPO_ROOT;

  let baselineTokens = 0;
  let packagedTokens = 0;
  let archivedCount = 0;
  let redactedCount = 0;
  let fidelityExact = true;
  const files: MicroResult["files"] = [];

  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    const expected = redactsOnStore ? redactSecrets(text) : text;
    const redacted = expected !== text;
    const before = countTokens(text);
    const projection = await projectToolResult({ tool: "read", text, policy }, { rootDir: packRoot });
    const after = countTokens(projection.projected);
    baselineTokens += before;
    packagedTokens += after;
    if (projection.archived && projection.handle) {
      archivedCount += 1;
      if (redacted) redactedCount += 1;
      const recalled = await recallObservation({ rootDir: packRoot, handle: projection.handle, policy });
      if (recalled.expired || recalled.content !== expected) fidelityExact = false;
    }
    files.push({
      path: path.slice(REPO_ROOT.length + 1),
      bytes: Buffer.byteLength(text, "utf8"),
      baselineTokens: before,
      packagedTokens: after,
      archived: projection.archived,
      redacted,
    });
  }

  // A full handle recall returns the whole result, so one recall costs about
  // one original result. Break-even = how many of the N results the agent may
  // fully re-read before the first-insertion saving is gone.
  const averageOriginalTokens = paths.length > 0 ? baselineTokens / paths.length : 0;
  const summary = summarizeAb(baselineTokens, packagedTokens, averageOriginalTokens);
  const result: MicroResult = {
    mode: "micro",
    generatedAt: new Date().toISOString(),
    commit: getCommitHash(),
    fileCount: paths.length,
    archivedCount,
    redactedCount,
    fidelityExact,
    baselineTokens,
    packagedTokens,
    savedTokens: summary.savedTokens,
    savingsRatio: summary.savingsRatio,
    breakEvenFullRecalls: summary.breakEvenFullRecalls,
    files,
  };

  const baselineArm: AbArm = { tokens: baselineTokens, turns: paths.length, responseCount: paths.length, score: 1 };
  const packagedArm: AbArm = {
    tokens: packagedTokens,
    turns: paths.length,
    responseCount: paths.length,
    score: fidelityExact ? 1 : 0,
  };
  recordIfRequested(record, "plugin-ab-micro", baselineArm, packagedArm);

  const lines = [
    "",
    "=== plugin A/B — micro: tool-result projection ===",
    "files (over-budget reads):  " + paths.length + "  (archived: " + archivedCount + ")",
    "first-insert tokens OFF:    " + baselineTokens,
    "first-insert tokens ON:     " + packagedTokens,
    "saved:                      " + summary.savedTokens + "  (" + (summary.savingsRatio * 100).toFixed(2) + "%)",
    "break-even full recalls:    " + (summary.breakEvenFullRecalls === null ? "n/a" : summary.breakEvenFullRecalls.toFixed(2)),
    "recall fidelity:           " + (fidelityExact ? "ok" : "FAILED") + "  (modulo declared redaction; " + redactedCount + " redacted)",
    "",
    "note: this is the first-insertion lever only. A handle the agent later",
    "recalls byte-exactly costs that result's tokens again; the saving is real",
    "only to the extent the truncated middle is never needed.",
  ];
  console.log(lines.join("\n"));
  return result;
}

function recordIfRequested(record: boolean, query: string, baseline: AbArm, packaged: AbArm): void {
  if (!record) return;
  const outcome = recordEfficiencyComparison(benchmarkConfig(), {
    query,
    baseline,
    packaged,
    source: "benchmark",
  });
  console.log("recorded -> " + outcome.path + "  qualifies=" + outcome.record.qualifies);
}

function resolveSessionFile(args: string[], flag: string, home: string): string {
  const value = readFlag(args, flag);
  if (!value) throw new Error("missing " + flag);
  if (existsSync(value)) return value;
  const dir = join(home, "storages", "session_projcache", "sessions");
  const bare = value.startsWith("session-") ? value.slice("session-".length) : value;
  // DSH has written both `session-<uuid>.json` and `<uuid>.json` over time.
  const candidates = [dshProjcachePath(home, value), join(dir, bare + ".json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("session not found: " + value + " (tried " + candidates.join(", ") + ")");
}

function runSession(args: string[]): void {
  const home = readFlag(args, "--ds-h-home") ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const metric = (readFlag(args, "--metric") ?? "total") as UsageTokenMetric;
  const baselineScore = readNumberFlag(args, "--baseline-score");
  const packagedScore = readNumberFlag(args, "--packaged-score");
  const record = hasFlag(args, "--record");

  const baselinePath = resolveSessionFile(args, "--baseline-session", home);
  const packagedPath = resolveSessionFile(args, "--packaged-session", home);
  const baselineSample = parseDshProjcacheUsage(JSON.parse(readFileSync(baselinePath, "utf8")), baselinePath);
  const packagedSample = parseDshProjcacheUsage(JSON.parse(readFileSync(packagedPath, "utf8")), packagedPath);
  if (!baselineSample || !packagedSample) throw new Error("could not parse token usage from a session projection");

  const baselineArm = usageToArm(baselineSample, metric, baselineScore);
  const packagedArm = usageToArm(packagedSample, metric, packagedScore);
  const summary = summarizeAb(baselineArm.tokens, packagedArm.tokens);

  const lines = [
    "",
    "=== plugin A/B — real DSH sessions (" + metric + " tokens) ===",
    "baseline (plugin OFF): " + baselineArm.tokens + " tokens  responses=" + (baselineArm.responseCount ?? "n/a"),
    "packaged (plugin ON):  " + packagedArm.tokens + " tokens  responses=" + (packagedArm.responseCount ?? "n/a"),
    "saved:                 " + summary.savedTokens + "  (" + (summary.savingsRatio * 100).toFixed(2) + "%)",
    "capability floor:      score " + (baselineArm.score ?? "unmeasured") + " -> " + (packagedArm.score ?? "unmeasured"),
    "                       responses " + (baselineArm.responseCount ?? "unmeasured") + " -> " + (packagedArm.responseCount ?? "unmeasured"),
  ];
  console.log(lines.join("\n"));
  recordIfRequested(record, "plugin-ab-session", baselineArm, packagedArm);
}

function plan(args: string[]): void {
  const baseline = readFlag(args, "--baseline-profile") ?? "headless";
  const packaged = readFlag(args, "--packaged-profile") ?? "headless-gf";
  const task = readFlag(args, "--task") ?? "<同一任务 prompt>";
  const lines = [
    "",
    "=== plugin A/B — two-run protocol (run manually; nothing executed) ===",
    "",
    "0. 准备（只做一次；同一 workspace、同一模型、同一 prompt）",
    "   dsh plugin --profile " + packaged + " --from-default-profile " + baseline + "   # 需要时先创建 profile",
    "   dsh plugin --profile " + packaged + " add @roarpeng/graphflow",
    "   graphflow graph index .                       # 让 ON 臂真的有图谱上下文",
    "",
    "1. 记录运行前的会话文件快照",
    "   ls ~/.dsh/storages/session_projcache/sessions",
    "",
    "2. 基线臂（插件 OFF）",
    "   dsh --profile " + baseline + " " + JSON.stringify(task),
    "",
    "3. 打包臂（插件 ON）",
    "   dsh --profile " + packaged + " " + JSON.stringify(task),
    "",
    "4. 对比两侧新出现的 session-*.json",
    "   npm run benchmark:plugin-ab -- --mode session \\",
    "     --baseline-session <OFF session id> --packaged-session <ON session id> \\",
    "     --baseline-score <0..1> --packaged-score <0..1> --record",
    "",
    "5. 读门禁",
    "   graphflow governance release-gate --min-efficiency-qualifying 1 --max-capability-regressions 0",
    "",
    "关键控制：两次运行必须使用同一模型、temperature、prompt、workspace 快照；",
    "每臂重复 >=3 次取中位数；ON 臂关闭 GRAPHFLOW_D_DSH_PROJECTION 的对照组另记一行。",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help")) {
    console.log("usage: run-plugin-ab [--mode micro|session|plan] [options]");
    return;
  }
  const mode = readFlag(args, "--mode") ?? "micro";
  let json: unknown;
  if (mode === "micro") {
    json = await runMicro(args);
  } else if (mode === "session") {
    runSession(args);
    json = { mode: "session" };
  } else if (mode === "plan") {
    plan(args);
    json = { mode: "plan" };
  } else {
    throw new Error("unknown --mode: " + mode);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(json, null, 2), "utf8");
  console.log("json -> " + JSON_PATH);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
