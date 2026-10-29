/**
 * GraphFlow — flywheel journal hygiene (inspect + TTL prune).
 *
 * `.graphflow/session-journal.jsonl` collects `pending-episode` entries that
 * hosts may never backfill. These tests pin the properties the prune must keep:
 *
 *  1. only expired `pending-episode` lines are removed — other kinds, fresh
 *     pendings, pendings without a numeric `createdAt`, and unparsable lines
 *     survive verbatim,
 *  2. the report numbers (pending total, status distribution, oldest age,
 *     over-TTL count) match a mixed journal, and a missing journal is a
 *     zero-value report, not an error,
 *  3. the journal is rewritten atomically (no stray `.tmp`) and a second prune
 *     is a no-op; the CLI subcommand is wired end to end.
 *
 * Standalone: `npx tsx tests/flywheel.test.ts`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectFlywheel, pruneFlywheel } from "../src/flywheel.js";
import { parseFlywheelArgs } from "../src/cli.js";

const failures: string[] = [];
let checks = 0;

function check(name: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

const sandboxes: string[] = [];
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "gf-flywheel-"));
  sandboxes.push(dir);
  return dir;
}

const DAY = 86_400_000;

function pendingLine(episodeId: string, status: string, createdAt: number): string {
  return (
    `{"version":1,"kind":"pending-episode","episodeId":"episode:${episodeId}",` +
    `"task":"task ${episodeId}","taskKey":"k-${episodeId}","status":"${status}",` +
    `"createdAt":${createdAt}}`
  );
}

/** Mixed journal: expired pendings, fresh pendings, other kinds, bad rows. */
function makeJournal(dir: string): { journalPath: string; expiredIds: string[]; keptLines: string[] } {
  const journalPath = join(dir, ".graphflow", "session-journal.jsonl");
  mkdirSync(join(dir, ".graphflow"), { recursive: true });
  const now = Date.now();
  const expiredIds = ["old1", "old2", "old3"];
  const keptLines = [
    pendingLine("fresh1", "DELEGATED", now - 2 * DAY),
    pendingLine("fresh2", "HUMAN_REVIEW_REQUIRED", now - 29 * DAY),
    `{"version":1,"kind":"pending-episode","episodeId":"episode:noDate","task":"no createdAt","taskKey":"k-noDate","status":"DELEGATED"}`,
    `{"version":1,"kind":"agent-turn","agentHint":"claude","action":"read","createdAt":${now - 400 * DAY}}`,
    `{"version":1,"kind":"episode","episodeId":"episode:closed","status":"CLOSED","createdAt":${now - 400 * DAY}}`,
    "{ this line is not json",
    pendingLine("strDate", "DELEGATED", now - 90 * DAY).replace(
      /"createdAt":\d+/,
      `"createdAt":"${new Date(now - 90 * DAY).toISOString()}"`
    ),
  ];
  const lines = [
    pendingLine("old1", "DELEGATED", now - 90 * DAY),
    pendingLine("old2", "DELEGATED", now - 45 * DAY),
    pendingLine("old3", "HUMAN_REVIEW_REQUIRED", now - 40 * DAY),
    ...keptLines,
  ];
  writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");
  return { journalPath, expiredIds, keptLines };
}

check("inspect reports pending totals, status split, oldest age and over-TTL count", () => {
  const dir = sandbox();
  makeJournal(dir);

  const report = inspectFlywheel(dir, 30);

  assert.equal(report.exists, true);
  assert.equal(report.totalLines, 10, "all non-empty lines are counted");
  assert.equal(report.pendingTotal, 7, "only pending-episode lines are pending");
  assert.equal(report.statusCounts["DELEGATED"], 5, "old1, old2, fresh1, noDate, strDate");
  assert.equal(report.statusCounts["HUMAN_REVIEW_REQUIRED"], 2, "old3, fresh2");
  assert.equal(report.statusCounts["(missing)"], undefined, "every pending here carries a status");
  assert.equal(report.parseErrors, 1, "exactly one unparsable line");
  assert.equal(report.overTtl, 3, "the three pendings older than 30 days");
  assert.ok(
    report.oldestPendingAgeDays !== null && report.oldestPendingAgeDays >= 90 && report.oldestPendingAgeDays < 91,
    `oldest pending age should be ~90 days, got ${String(report.oldestPendingAgeDays)}`
  );
  assert.equal(report.ttlDays, 30);
  // Status of a non-pending kind (episode CLOSED, and the agent-turn) must not leak into the split.
  assert.equal(report.statusCounts["CLOSED"], undefined);
});

check("inspect on a missing journal returns a zero-value report without throwing", () => {
  const dir = sandbox();
  const report = inspectFlywheel(dir, 30);
  assert.equal(report.exists, false);
  assert.equal(report.pendingTotal, 0);
  assert.equal(report.totalLines, 0);
  assert.equal(report.overTtl, 0);
  assert.equal(report.parseErrors, 0);
  assert.deepEqual(report.statusCounts, {});
  assert.equal(report.oldestPendingAgeDays, null);
  assert.equal(existsSync(report.journalPath), false, "inspect must not create the journal");
});

check("prune removes only expired pendings and keeps every other line verbatim", () => {
  const dir = sandbox();
  const { journalPath, expiredIds, keptLines } = makeJournal(dir);

  const result = pruneFlywheel(dir, 30);

  assert.equal(result.existed, true);
  assert.equal(result.pruned, 3, "exactly the three expired pendings");
  assert.equal(result.kept, 7, "fresh pendings, other kinds and the bad line stay");
  assert.equal(result.parseErrors, 1);
  assert.equal(result.ttlDays, 30);

  const after = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
  assert.equal(after.length, 7);
  for (const id of expiredIds) {
    assert.ok(!after.some((l) => l.includes(`episode:${id}`)), `expired ${id} must be gone`);
  }
  for (const line of keptLines) {
    assert.ok(after.includes(line), `line must survive byte-for-byte: ${line.slice(0, 60)}`);
  }
});

check("a second prune is a no-op and leaves no stray temp file", () => {
  const dir = sandbox();
  makeJournal(dir);
  pruneFlywheel(dir, 30);
  const journalDir = join(dir, ".graphflow");
  const strays = readdirSync(journalDir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(strays, [], `stray temp files: ${strays.join(", ")}`);

  const second = pruneFlywheel(dir, 30);
  assert.equal(second.pruned, 0);
  assert.equal(second.kept, 7);
  assert.equal(second.parseErrors, 1);
});

check("prune keeps fresh pendings when a tighter TTL flips them to expired", () => {
  const dir = sandbox();
  const { journalPath } = makeJournal(dir);
  // TTL 3 days: old1..3 and fresh2 (29d) expire; fresh1 (2d) is still inside the window;
  // noDate/strDate pendings, the other kinds and the bad line always stay.
  const result = pruneFlywheel(dir, 3);
  assert.equal(result.pruned, 4, "old1..3 + fresh2");
  assert.equal(result.kept, 6, "fresh1, noDate, strDate, agent-turn, episode, bad line");
  const after = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
  assert.ok(after.some((l) => l.includes("episode:fresh1")), "2-day-old entry survives a 3-day TTL");
  assert.ok(after.some((l) => l.includes("episode:noDate")));
  assert.ok(after.some((l) => l.includes("episode:closed")));
});

check("prune on a missing journal is a no-op that creates nothing", () => {
  const dir = sandbox();
  const result = pruneFlywheel(dir, 30);
  assert.equal(result.existed, false);
  assert.equal(result.pruned, 0);
  assert.equal(result.kept, 0);
  assert.equal(existsSync(join(dir, ".graphflow", "session-journal.jsonl")), false);
});

check("prune rejects a non-positive TTL instead of pruning everything", () => {
  const dir = sandbox();
  makeJournal(dir);
  assert.throws(() => pruneFlywheel(dir, 0), /positive number of days/);
  assert.throws(() => pruneFlywheel(dir, Number.NaN), /positive number of days/);
});

check("parseFlywheelArgs defaults to a 30-day dry run and validates --ttl-days", () => {
  assert.deepEqual(parseFlywheelArgs([]), { prune: false, ttlDays: 30 });
  assert.deepEqual(parseFlywheelArgs(["--prune", "--ttl-days", "7", "--root", "/w"]), {
    prune: true,
    ttlDays: 7,
    rootDir: "/w",
  });
  assert.equal(parseFlywheelArgs(["--ttl-days=10"]).ttlDays, 10, "--ttl-days=N form");
  assert.ok(Number.isNaN(parseFlywheelArgs(["--ttl-days", "0"]).ttlDays), "0 is invalid");
  assert.ok(Number.isNaN(parseFlywheelArgs(["--ttl-days", "abc"]).ttlDays), "garbage is invalid");
});

check("CLI: `graphflow flywheel --prune` prints the report then prunes", () => {
  const dir = sandbox();
  makeJournal(dir);
  const tsxLoader = pathToFileURL(
    join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")
  ).href;
  const cli = join(process.cwd(), "src", "cli.ts");
  const child = spawnSync(
    process.execPath,
    ["--import", tsxLoader, cli, "flywheel", "--prune", "--ttl-days", "30", "--root", dir],
    { cwd: dir, encoding: "utf8", timeout: 120_000, windowsHide: true }
  );
  assert.equal(child.status, 0, `CLI must exit 0\nstdout:${child.stdout}\nstderr:${child.stderr}`);
  assert.ok(child.stdout.includes("pending episodes: 7"), child.stdout);
  assert.ok(child.stdout.includes("over TTL (30 days): 3"), child.stdout);
  assert.ok(child.stdout.includes("OK [flywheel-pruned] pruned=3 kept=7 parseErrors=1 ttlDays=30"), child.stdout);
  const after = readFileSync(join(dir, ".graphflow", "session-journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(after.length, 7);
});

for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });

console.log(`\n${checks - failures.length} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
