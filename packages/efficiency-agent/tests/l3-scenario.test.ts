import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExperienceStore } from "../src/agent/experience.js";
import { runEfficiencyPipeline, type PipelineInput, type PipelineResult } from "../src/agent/pipeline.js";
import { benchArmFlags } from "../src/flags.js";
import { collectProjectFacts } from "../src/host/project-facts.js";
import { replayProblems } from "../src/observability/replay.js";
import type { TaskTrace } from "../src/trace.js";
import { memoryKv } from "./helpers/pipeline-fixtures.js";

const TASK = "Change value in src/a.ts to return 2";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
}

/** A committed repo: src/a.ts returns 1; check.cjs passes only once it returns 2. */
function createRepo(): string {
  const repo = tempDir("eff-l3-repo-");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export function value(): number {\n  return 1;\n}\n");
  writeFileSync(
    join(repo, "check.cjs"),
    [
      "const fs = require('fs');",
      "const text = fs.readFileSync('src/a.ts', 'utf8');",
      "if (!text.includes('return 2')) {",
      "  console.error('expected src/a.ts to return 2');",
      "  process.exit(1);",
      "}",
      "console.log('check ok');",
    ].join("\n")
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "l3-fixture", scripts: { test: "node check.cjs" } }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "eff-agent-test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "core.excludesFile", join(repo, ".no-global-excludes")]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--no-verify", "-m", "init"]);
  return repo;
}

/** Stand-in agent CLI: saves its prompt to $PROMPT_OUT, then edits src/a.ts to return 2. */
const AGENT = [
  "const fs = require('fs');",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (c) => (input += c));",
  "process.stdin.on('end', () => {",
  "  fs.writeFileSync(process.env.PROMPT_OUT, input);",
  "  const file = 'src/a.ts';",
  "  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('return 1', 'return 2'));",
  "  console.log('ANSWER: value() in src/a.ts now returns 2');",
  "});",
].join("\n");

describe("L3 scenario: real git repo, real project facts, shared experience", () => {
  it("edits, validates, audits writes, and recalls the experience on a fresh second run", async () => {
    const tools = tempDir("eff-l3-tools-");
    const agentScript = join(tools, "agent.cjs");
    writeFileSync(agentScript, AGENT);
    const experience = createExperienceStore(join(tools, "experience.jsonl"));
    const traces: TaskTrace[] = [];

    const runIn = (repo: string, promptOut: string): Promise<PipelineResult> => {
      const input: PipelineInput = {
        task: TASK,
        root: repo,
        mode: "broker",
        policy: "conservative",
        validation: ["node check.cjs"],
        executor: {
          command: process.execPath,
          args: [agentScript],
          promptVia: "stdin",
          timeoutMs: 30_000,
          env: { PROMPT_OUT: promptOut },
        },
        flags: benchArmFlags("conservative"),
      };
      // Fresh caches/tool/policy state per run; only the experience store is shared.
      return runEfficiencyPipeline(input, {
        collectFacts: (root, task) => collectProjectFacts(root, task),
        cacheStore: memoryKv(),
        toolStore: memoryKv(),
        policyKv: memoryKv(),
        experience,
        traceSink: (t) => void traces.push(t),
      });
    };

    // Run 1.
    const repo1 = createRepo();
    const head1 = git(repo1, ["rev-parse", "HEAD"]).trim();
    const first = await runIn(repo1, join(tools, "prompt-1.txt"));
    expect(first.mode).toBe("broker");
    expect(first.category).toBe("single-file");
    expect(first.status).toBe("completed");
    expect(first.statusReason).toMatch(/every validation command passed/);
    expect(first.contract.project?.gitHead).toBe(head1);
    expect(first.twin.relevantFiles).toContain("src/a.ts");
    expect(first.context.source).toBe("twin-only");
    expect(first.experience.similar).toEqual([]);
    expect(first.security.verdict).toBe("allow");
    expect(first.writeAudit).toEqual({ verdict: "allow", newlyChanged: ["src/a.ts"] });
    expect(readFileSync(join(repo1, "src", "a.ts"), "utf8")).toContain("return 2");
    expect(git(repo1, ["status", "--porcelain"]).trim()).toBe("M src/a.ts");
    expect(first.trace?.validationStatus).toBe("passed");
    expect(replayProblems(first.trace!)).toEqual([]);
    const prompt1 = readFileSync(join(tools, "prompt-1.txt"), "utf8");
    expect(prompt1).toContain(`TASK: ${TASK}`);
    expect(prompt1).toContain("RELEVANT FILES: src/a.ts");
    expect(prompt1).not.toContain("PAST SIMILAR TASKS");
    expect(experience.read()).toHaveLength(1);

    // Run 2: same task, fresh repo and fresh caches, shared experience store.
    const repo2 = createRepo();
    const second = await runIn(repo2, join(tools, "prompt-2.txt"));
    expect(second.status).toBe("completed");
    expect(second.appliedDecision.reuseMode).toBe("FRESH");
    expect(second.experience.similar.length).toBeGreaterThan(0);
    expect(second.experience.similar[0]).toMatchObject({ task: TASK, status: "completed", similarity: 1 });
    expect(second.events.find((e) => e.stage === "experience")?.outcome).toBe("similar-found");
    expect(second.contract.experience?.episodes).toContain(first.contract.taskId);
    expect(second.contract.signals.similarEpisodeCount).toBeGreaterThan(0);
    expect(second.writeAudit).toEqual({ verdict: "allow", newlyChanged: ["src/a.ts"] });
    const prompt2 = readFileSync(join(tools, "prompt-2.txt"), "utf8");
    expect(prompt2).toContain("PAST SIMILAR TASKS");
    expect(prompt2).toContain("UNTRUSTED DATA (experience)");
    expect(experience.read()).toHaveLength(2);
    expect(traces).toHaveLength(2);
  }, 60_000);
});
