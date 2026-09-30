import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { recordEpisode, loadAllEpisodes } from "../src/learning/episodic-memory";
import {
  extractNamedFiles,
  reconcileEpisodes,
  type ReconcileOptions,
  type ReconcileReport,
} from "../src/learning/outcome-reconciler";
import type { OutcomeEvidenceInput } from "../src/learning/evidence";

/**
 * Outcome closure must not depend on the agent admitting anything, and must not
 * invent a success it cannot support. These tests pin both halves: a pass needs
 * a green verify run AND a commit touching the file the episode named; anything
 * weaker leaves the episode exactly where it was, with the reason recorded.
 */

const root = join(tmpdir(), `graphflow-reconcile-${Date.now()}`);

const PASS_COMMAND = "node -e \"process.exit(0)\"";
const FAIL_COMMAND = "node -e \"process.exit(1)\"";

function git(args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

beforeAll(() => {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/packer.ts"), "export const quota = 6;\n");
  git(["init", "-q"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "seed"]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function commitTouching(relPath: string): void {
  writeFileSync(join(root, relPath), `export const quota = 7; // ${Date.now()}\n`);
  git(["add", "-A"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", `touch ${relPath}`]);
}

async function episodeClient(task: string) {
  const client = new GraphifyClient();
  await recordEpisode(client, {
    task,
    plan: [],
    outcome: "pending",
    keyDecisions: [],
    lessons: [],
    attempts: 1,
  });
  return client;
}

async function run(
  client: InstanceType<typeof GraphifyClient>,
  options: Partial<ReconcileOptions> = {}
): Promise<{ report: ReconcileReport; written: OutcomeEvidenceInput[] }> {
  const written: OutcomeEvidenceInput[] = [];
  const report = await reconcileEpisodes(
    client,
    { workspaceRoot: root, ...options },
    async (_id, evidence) => {
      written.push(evidence);
      return true;
    }
  );
  return { report, written };
}

describe("extractNamedFiles", () => {
  it("keeps only path tokens that exist in the workspace, and rejects traversal", () => {
    expect(extractNamedFiles(["把 src/packer.ts 的配额调大"], root)).toEqual(["src/packer.ts"]);
    expect(extractNamedFiles(["../outside/leak.ts and src/packer.ts"], root)).toEqual(["src/packer.ts"]);
    expect(extractNamedFiles(["nothing pathlike here"], root)).toEqual([]);
  });
});

describe("reconcileEpisodes", () => {
  it("writes nothing when no verify command is configured", async () => {
    commitTouching("src/packer.ts");
    const client = await episodeClient("再改一次 src/packer.ts 的配额");
    const { report, written } = await run(client, { verifyCommand: undefined });
    expect(written).toHaveLength(0);
    expect(report.counts["no-verify-command"]).toBe(1);
    expect((await loadAllEpisodes(client))[0]?.outcome).toBe("pending");
  });

  it("writes nothing when the verify command fails", async () => {
    const client = await episodeClient("修复 src/packer.ts 的配额");
    const { report, written } = await run(client, { verifyCommand: FAIL_COMMAND });
    expect(written).toHaveLength(0);
    expect(report.counts["verify-failed"]).toBe(1);
    expect(report.verifyExitCode).not.toBe(0);
  });

  it("passes only when the suite is green AND a commit touched the named file", async () => {
    commitTouching("src/packer.ts");
    const client = await episodeClient("调整 src/packer.ts 的 layerQuota");
    const { report, written } = await run(client, { verifyCommand: PASS_COMMAND });
    expect(report.counts.pass).toBe(1);
    expect(written).toHaveLength(1);
    expect(report.results[0]?.commits).toBeGreaterThanOrEqual(1);
    expect(/^[0-9a-f]{40}$/.test(String(written[0]?.commit))).toBe(true);
    expect(written[0]?.testResult).toBe("pass");
    expect(written[0]?.testCommand).toBe(PASS_COMMAND);
  });

  it("stamps provenance and never claims the user confirmed it", async () => {
    commitTouching("src/packer.ts");
    const client = await episodeClient("重构 src/packer.ts 的打包顺序");
    const { written } = await run(client, { verifyCommand: PASS_COMMAND });
    expect(written[0]?.source).toBe("reconcile");
    expect(written[0]?.userConfirmed).toBe(false);
  });

  it("leaves the episode pending when no commit in the window touches the named file", async () => {
    const client = await episodeClient("看看 src/unreached.ts 里的情况");
    const { report, written } = await run(client, { verifyCommand: PASS_COMMAND });
    expect(written).toHaveLength(0);
    expect(report.counts["no-named-files"] + report.counts["no-commit-in-window"]).toBe(1);
  });

  it("dry-run counts the pass without writing it", async () => {
    commitTouching("src/packer.ts");
    const client = await episodeClient("确认 src/packer.ts 的预算");
    const { report, written } = await run(client, { verifyCommand: PASS_COMMAND, dryRun: true });
    expect(report.counts.pass).toBe(1);
    expect(report.written).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("flags a pass that carries no lesson: closed, but nothing to learn from", async () => {
    commitTouching("src/packer.ts");
    const client = await episodeClient("核对 src/packer.ts 的常量");
    const { report } = await run(client, { verifyCommand: PASS_COMMAND });
    expect(report.counts.pass).toBe(1);
    expect(report.passesWithoutLessons).toBe(1);
  });
});
