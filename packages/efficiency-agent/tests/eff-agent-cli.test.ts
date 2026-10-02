import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags, runCli, type CliIo } from "../bin/eff-agent.js";
import type { TaskTrace } from "../src/trace.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const CORPUS = join(PKG, "benchmarks", "golden-v1.jsonl");
const NODE = process.execPath;
const T = 30_000;

/** Minimal env: what a child process needs to start, plus explicit flags. Never the operator's EFF_* values. */
function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "ComSpec", "TEMP", "TMP", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
const ACTING_ENV = { EFF_AGENT_ENABLED: "1", EFF_SHADOW_MODE: "0" };

interface Capture {
  io: Required<CliIo>;
  out: () => string;
  err: () => string;
}

function capture(cwd: string, env: Record<string, string> = minimalEnv()): Capture {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (msg) => void (stdout += msg + "\n"),
      stderr: (msg) => void (stderr += msg + "\n"),
      cwd,
      env,
    },
    out: () => stdout,
    err: () => stderr,
  };
}

let root: string;
let work: string;
let stateDir: string;
let agentScript: string;
let passScript: string;
let tracesFile: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "eff-cli-"));
  work = join(root, "work");
  stateDir = join(root, "state");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q"]);
  git(work, ["config", "user.name", "Eff Test"]);
  git(work, ["config", "user.email", "eff-test@example.invalid"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(work, "README.md"), "# cli fixture\n");
  writeFileSync(join(work, ".gitignore"), "tools/\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init"]);
  const tools = join(work, "tools");
  mkdirSync(tools, { recursive: true });
  agentScript = join(tools, "fake-agent.cjs");
  writeFileSync(
    agentScript,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => (input += c));",
      "process.stdin.on('end', () => console.log('ANSWER: handled task; prompt chars=' + input.length));",
    ].join("\n")
  );
  passScript = join(tools, "pass.cjs");
  writeFileSync(passScript, "process.exit(0);\n");
  tracesFile = join(root, "traces.jsonl");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** run argv with the always-on isolation flags. */
function runArgs(task: string, ...extra: string[]): string[] {
  return ["run", task, "--no-graphflow", "--state-dir", stateDir, ...extra];
}
const executorArgs = () => ["--worker", "external", "--cli-command", NODE, "--cli-args", `"${agentScript}"`];
const passValidation = () => [`--validation=${JSON.stringify(NODE)} ${JSON.stringify(passScript)}`];

describe("eff-agent CLI", () => {
  describe("flag parsing", () => {
    it("parses equal-separated and space-separated flags", () => {
      const { flags, positional } = parseFlags([
        "run",
        "my task",
        "--mode=shadow",
        "--worker",
        "external",
        "--policy=adaptive",
        "--limit",
        "10",
        "--json",
        "--validation=node -e '1'",
        "--validation=node -e '2'",
        "--only",
        "rep-001, failure",
        "--no-graphflow",
        "--gate",
      ]);
      expect(positional).toEqual(["run", "my task"]);
      expect(flags.mode).toBe("shadow");
      expect(flags.worker).toBe("external");
      expect(flags.policy).toBe("adaptive");
      expect(flags.limit).toBe(10);
      expect(flags.json).toBe(true);
      expect(flags.validation).toEqual(["node -e '1'", "node -e '2'"]);
      expect(flags.only).toEqual(["rep-001", "failure"]);
      expect(flags.noGraphflow).toBe(true);
      expect(flags.gate).toBe(true);
    });

    it("never consumes a following --flag as a value", () => {
      const { flags } = parseFlags(["--mode", "--json"]);
      expect(flags.mode).toBeUndefined();
      expect(flags.json).toBe(true);
    });

    it("parses version and help flags", () => {
      expect(parseFlags(["--version"]).flags.version).toBe(true);
      expect(parseFlags(["-h"]).flags.help).toBe(true);
    });
  });

  describe("version / help", () => {
    it("--version prints eff-agent 0.1.0", async () => {
      const c = capture(work);
      expect(await runCli(["--version"], c.io)).toBe(0);
      expect(c.out().trim()).toBe("eff-agent 0.1.0");
    });

    it("--help prints usage and exit codes (ASCII only)", async () => {
      const c = capture(work);
      expect(await runCli(["--help"], c.io)).toBe(0);
      expect(c.out()).toContain("GraphFlow Efficiency Agent CLI");
      expect(c.out()).toContain("blocked by the security policy 5");
      expect(/^[\x00-\x7F]*$/.test(c.out())).toBe(true);
    });

    it("unknown command exits 2", async () => {
      const c = capture(work);
      expect(await runCli(["frobnicate"], c.io)).toBe(2);
    });
  });

  describe("run", () => {
    it("errors when the task argument is missing", async () => {
      const c = capture(work);
      expect(await runCli(["run"], c.io)).toBe(2);
      expect(c.err()).toContain("missing required argument <task>");
    });

    it(
      "--mode advisory prints the section 27 pipeline and exits 0",
      async () => {
        const c = capture(work);
        const code = await runCli(runArgs("Inspect the routing table", "--mode=advisory"), c.io);
        expect(code).toBe(0);
        const out = c.out();
        expect(out).toContain("=== Efficiency Agent Run (section 27 pipeline) ===");
        expect(out).toContain("Task: Inspect the routing table");
        expect(out).toContain("Mode: advisory");
        expect(out).toContain("9. Execution: none");
        expect(out).toContain("Status: advisory-only");
        expect(/^[\x00-\x7F]*$/.test(out)).toBe(true);
        expect(existsSync(join(work, "graphflow-out"))).toBe(false);
      },
      T
    );

    it(
      "--mode advisory --json emits the pipeline result",
      async () => {
        const c = capture(work);
        expect(await runCli(runArgs("Inspect the routing table", "--mode=advisory", "--json"), c.io)).toBe(0);
        const json = JSON.parse(c.out()) as { mode: string; task: string; status: string; contract: { schemaVersion: string } };
        expect(json.mode).toBe("advisory");
        expect(json.task).toBe("Inspect the routing table");
        expect(json.status).toBe("advisory-only");
        expect(json.contract.schemaVersion).toBe("1.0");
      },
      T
    );

    it(
      "default flags cap broker to shadow; no executor and no validation -> not-executed (3)",
      async () => {
        const c = capture(work);
        const code = await runCli(runArgs("Fix the parser bug"), c.io);
        expect(code).toBe(3);
        const out = c.out();
        expect(out).toContain("Requested conservative, capped to shadow: EFF_AGENT_ENABLED=0");
        expect(out).toContain("Status: not-executed");
      },
      T
    );

    it(
      "fake agent with no validation -> unverified (4)",
      async () => {
        const c = capture(work);
        const code = await runCli(runArgs("Fix the parser bug", ...executorArgs()), c.io);
        expect(code).toBe(4);
        expect(c.out()).toContain("Status: unverified");
        expect(c.out()).toContain("ANSWER: handled task");
      },
      T
    );

    it(
      "flags enabled via env + passing validation -> completed (0); trace written to --output",
      async () => {
        const c = capture(work, minimalEnv(ACTING_ENV));
        const code = await runCli(runArgs("Fix the parser bug", ...executorArgs(), ...passValidation(), "--output", tracesFile), c.io);
        expect(c.err()).toBe("");
        expect(code).toBe(0);
        const out = c.out();
        expect(out).toContain("Mode: broker | Policy: conservative");
        expect(out).not.toContain("capped to shadow");
        expect(out).toContain("Status: completed");
        expect(out).toMatch(/PASS validate: /);
        expect(out).toContain("Write audit: allow; 0 path(s) changed");
        const lines = readFileSync(tracesFile, "utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
        const trace = JSON.parse(lines[0]!) as TaskTrace;
        expect(trace.result.success).toBe(true);
        expect(trace.run.mode).toBe("conservative");
      },
      T
    );

    it(
      "validation needing the network is blocked (5) before anything runs",
      async () => {
        const c = capture(work, minimalEnv(ACTING_ENV));
        const code = await runCli(runArgs("Fix the parser bug", "--validation", "curl https://example.invalid/health"), c.io);
        expect(code).toBe(5);
        expect(c.out()).toContain("Status: blocked");
        expect(c.out()).toContain("9. Execution: none");
      },
      T
    );

    it(
      "agent writing files on a read-only task is a violation (6)",
      async () => {
        const writer = join(work, "tools", "writer-agent.cjs");
        writeFileSync(
          writer,
          "process.stdin.resume(); process.stdin.on('end', () => { require('fs').writeFileSync('hacked.txt', 'x'); console.log('ANSWER: wrote'); });"
        );
        const c = capture(work, minimalEnv(ACTING_ENV));
        try {
          const code = await runCli(
            runArgs("Where is the model router configured?", "--worker", "external", "--cli-command", NODE, "--cli-args", `"${writer}"`, ...passValidation()),
            c.io
          );
          expect(c.out()).toContain("Status: violation");
          expect(c.out()).toContain("hacked.txt");
          expect(code).toBe(6);
        } finally {
          rmSync(join(work, "hacked.txt"), { force: true });
        }
      },
      T
    );

    it.each([
      ["--mode", "turbo"],
      ["--worker", "robot"],
      ["--policy", "reckless"],
      ["--advisor", "oracle"],
      ["--prompt-via", "pigeon"],
    ])("unknown %s value exits 2", async (flag, value) => {
      const c = capture(work);
      const extra = flag === "--prompt-via" ? ["--cli-command", NODE] : [];
      expect(await runCli(runArgs("Fix the parser bug", ...extra, flag, value), c.io)).toBe(2);
      expect(c.err()).toContain(`unknown ${flag} '${value}'`);
    });

    it("--worker external without --cli-command exits 2", async () => {
      const c = capture(work);
      expect(await runCli(runArgs("Fix the parser bug", "--worker", "external"), c.io)).toBe(2);
      expect(c.err()).toContain("--worker external needs --cli-command");
    });

    it("--worker local with --cli-command, --worker baseline and --worker jev exit 2", async () => {
      for (const extra of [["--worker", "local", "--cli-command", NODE], ["--worker", "baseline"], ["--worker", "jev"]]) {
        const c = capture(work);
        expect(await runCli(runArgs("Fix the parser bug", ...extra), c.io)).toBe(2);
      }
    });

    it("--timeout-ms must be positive", async () => {
      const c = capture(work);
      expect(await runCli(runArgs("Fix the parser bug", "--cli-command", NODE, "--timeout-ms", "0"), c.io)).toBe(2);
      expect(c.err()).toContain("--timeout-ms must be a positive number");
    });
  });

  describe("bench run", () => {
    it("missing corpus argument exits 2", async () => {
      const c = capture(work);
      expect(await runCli(["bench", "run"], c.io)).toBe(2);
      expect(c.err()).toContain("missing required argument <tasks.jsonl>");
    });

    it("unknown corpus file exits 1", async () => {
      const c = capture(work);
      expect(await runCli(["bench", "run", join(root, "nope.jsonl"), "--arm", "baseline"], c.io)).toBe(1);
      expect(c.err()).toContain("corpus file not found");
    });

    it("refuses to run without --cli-command (exit 2)", async () => {
      const c = capture(work);
      expect(await runCli(["bench", "run", CORPUS, "--arm", "baseline", "--state-dir", stateDir], c.io)).toBe(2);
      expect(c.err()).toContain("bench run needs a real executor");
    });

    it("needs an arm; local/jev workers and conflicting arm flags exit 2", async () => {
      for (const extra of [[], ["--worker", "local"], ["--worker", "baseline", "--mode", "broker"], ["--arm", "turbo"]]) {
        const c = capture(work);
        expect(await runCli(["bench", "run", CORPUS, "--cli-command", NODE, ...extra], c.io)).toBe(2);
      }
    });

    it("unknown bench subcommand exits 2", async () => {
      const c = capture(work);
      expect(await runCli(["bench", "sprint"], c.io)).toBe(2);
    });
  });

  describe("bench compare / trace replay (over a trace from an acting run)", () => {
    let baseTrace: TaskTrace;

    beforeAll(async () => {
      if (!existsSync(tracesFile)) {
        const c = capture(work, minimalEnv(ACTING_ENV));
        await runCli(runArgs("Fix the parser bug", ...executorArgs(), ...passValidation(), "--output", tracesFile), c.io);
      }
      baseTrace = JSON.parse(readFileSync(tracesFile, "utf8").trim().split("\n")[0]!) as TaskTrace;
    }, T);

    const writeTraces = (name: string, traces: TaskTrace[]): string => {
      const file = join(root, name);
      writeFileSync(file, traces.map((t) => JSON.stringify(t)).join("\n") + "\n");
      return file;
    };
    const withCost = (ms: number): TaskTrace => ({ ...baseTrace, cost: { actual: { value: ms, provenance: "measured" } } });

    it("missing arguments exit 2; missing files exit 1", async () => {
      const c = capture(work);
      expect(await runCli(["bench", "compare", tracesFile], c.io)).toBe(2);
      expect(await runCli(["bench", "compare", join(root, "nope.jsonl"), tracesFile], c.io)).toBe(1);
      expect(c.err()).toContain("baseline file not found");
    });

    it("REFUSES when the measurement contract is violated; labels candidate[i]", async () => {
      const bad = { ...baseTrace, llm: { calls: { value: 5, provenance: "estimated" as const } } };
      const base = writeTraces("refuse-base.jsonl", [baseTrace]);
      const cand = writeTraces("refuse-cand.jsonl", [baseTrace, bad]);
      const c = capture(work);
      expect(await runCli(["bench", "compare", base, cand], c.io)).toBe(1);
      expect(c.err()).toContain("compare REFUSED - measurement contract violations:");
      expect(c.err()).toContain("candidate[1]: llm.calls: estimated values require a method string");
      expect(c.err()).not.toContain("baseline[");
      expect(c.out()).toBe("");
      const c2 = capture(work);
      expect(await runCli(["bench", "compare", cand, base], c2.io)).toBe(1);
      expect(c2.err()).toContain("baseline[1]:");
    });

    it("happy path prints the comparison and acceptance gates; --gate passes when every gate holds", async () => {
      const base = writeTraces("happy-base.jsonl", [withCost(1_000)]);
      const cand = writeTraces("happy-cand.jsonl", [withCost(500)]);
      const c = capture(work);
      expect(await runCli(["bench", "compare", base, cand], c.io)).toBe(0);
      const out = c.out();
      expect(out).toContain("=== Efficiency Benchmark Comparison ===");
      expect(out).toContain("Tasks Compared: 1 (paired by task id)");
      expect(out).toContain("Net Saving: 500ms (50%)");
      expect(out).toContain("Acceptance gates (section 28):");
      expect(out).toContain("PASS net saving > 0");
      expect(out).toContain("PASS 100% trace replay");
      expect(out).toContain("N/A  success >= baseline");
      expect(/^[\x00-\x7F]*$/.test(out)).toBe(true);
      const g = capture(work);
      expect(await runCli(["bench", "compare", base, cand, "--gate"], g.io)).toBe(0);
    });

    it("--gate returns 1 when a gate fails (without --gate still 0)", async () => {
      const base = writeTraces("gate-base.jsonl", [withCost(500)]);
      const cand = writeTraces("gate-cand.jsonl", [withCost(2_000)]);
      const c = capture(work);
      expect(await runCli(["bench", "compare", base, cand], c.io)).toBe(0);
      expect(c.out()).toContain("FAIL net saving > 0");
      const g = capture(work);
      expect(await runCli(["bench", "compare", base, cand, "--gate"], g.io)).toBe(1);
    });

    it("--json emits the report", async () => {
      const base = writeTraces("json-base.jsonl", [withCost(1_000)]);
      const c = capture(work);
      expect(await runCli(["bench", "compare", base, base, "--json"], c.io)).toBe(0);
      const report = JSON.parse(c.out()) as { tasksCompared: number; gates: unknown[] };
      expect(report.tasksCompared).toBe(1);
      expect(report.gates).toHaveLength(5);
    });

    it("trace replay prints Replay: COMPLETE and writes OTLP JSON with --otel-out", async () => {
      const otel = join(root, "otel", "spans.json");
      const c = capture(work);
      expect(await runCli(["trace", "replay", tracesFile, "--otel-out", otel], c.io)).toBe(0);
      const out = c.out();
      expect(out).toContain(`Trace ${baseTrace.traceId}`);
      expect(out).toContain("Replay: COMPLETE");
      expect(out).toContain("Replayable: 1/1");
      expect(out).toContain("OTLP JSON written to");
      const otlp = JSON.parse(readFileSync(otel, "utf8")) as { resourceSpans?: unknown[] };
      expect(Array.isArray(otlp.resourceSpans)).toBe(true);
      expect(otlp.resourceSpans!.length).toBeGreaterThan(0);
    });

    it("trace replay --id filters; unknown id / missing file exit 1; incomplete trace exits 1", async () => {
      const ok = capture(work);
      expect(await runCli(["trace", "replay", tracesFile, "--id", baseTrace.traceId, "--json"], ok.io)).toBe(0);
      expect(JSON.parse(ok.out())).toEqual({ traces: 1, replayable: 1 });
      const none = capture(work);
      expect(await runCli(["trace", "replay", tracesFile, "--id", "no-such-trace"], none.io)).toBe(1);
      expect(none.err()).toContain("no matching traces");
      expect(await runCli(["trace", "replay", join(root, "missing.jsonl")], capture(work).io)).toBe(1);
      const { events: _events, ...noEvents } = baseTrace;
      void _events;
      const broken = writeTraces("broken.jsonl", [noEvents as TaskTrace]);
      const inc = capture(work);
      expect(await runCli(["trace", "replay", broken], inc.io)).toBe(1);
      expect(inc.out()).toContain("Replay: INCOMPLETE - missing events");
      expect(await runCli(["trace"], capture(work).io)).toBe(2);
    });
  });

  describe("operations: flags / cache / policy", () => {
    let opsDir: string;
    beforeAll(() => {
      opsDir = join(root, "ops-state");
    });

    it("flags set / get / rollback round-trip in a tmp state dir", async () => {
      const set = capture(work);
      expect(await runCli(["flags", "set", "EFF_AGENT_ENABLED=1", "EFF_SHADOW_MODE=0", "--state-dir", opsDir], set.io)).toBe(0);
      expect(set.out()).toContain("EFF_AGENT_ENABLED=1  [file]");
      expect(set.out()).toContain("EFF_SHADOW_MODE=0  [file]");
      expect(JSON.parse(readFileSync(join(opsDir, "flags.json"), "utf8"))).toEqual({ EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false });

      const get = capture(work, minimalEnv({ EFF_PLAN_REUSE: "1" }));
      expect(await runCli(["flags", "get", "--state-dir", opsDir, "--json"], get.io)).toBe(0);
      const resolved = JSON.parse(get.out()) as { flags: Record<string, boolean>; sources: Record<string, string> };
      expect(resolved.flags.EFF_AGENT_ENABLED).toBe(true);
      expect(resolved.sources.EFF_AGENT_ENABLED).toBe("file");
      expect(resolved.flags.EFF_PLAN_REUSE).toBe(true);
      expect(resolved.sources.EFF_PLAN_REUSE).toBe("env");
      expect(resolved.sources.EFF_RESULT_REUSE).toBe("default");

      const rb = capture(work);
      expect(await runCli(["flags", "rollback", "--state-dir", opsDir], rb.io)).toBe(0);
      expect(rb.out()).toContain("EFF_AGENT_ENABLED=0  [file]");
      expect(rb.out()).toContain("EFF_SHADOW_MODE=1  [file]");
      expect(JSON.parse(readFileSync(join(opsDir, "flags.json"), "utf8"))).toEqual({ EFF_AGENT_ENABLED: false, EFF_SHADOW_MODE: true });
    });

    it("flags file values drive run mode capping", async () => {
      const dir = join(root, "flag-run-state");
      expect(await runCli(["flags", "set", "EFF_AGENT_ENABLED=1", "--state-dir", dir], capture(work).io)).toBe(0);
      const c = capture(work);
      expect(await runCli(["run", "Fix the parser bug", "--no-graphflow", "--state-dir", dir], c.io)).toBe(3);
      expect(c.out()).toContain("capped to shadow: EFF_SHADOW_MODE=1");
    }, T);

    it("flags set rejects bad input (exit 2)", async () => {
      for (const argv of [["flags", "set"], ["flags", "set", "EFF_NOPE=1"], ["flags", "set", "EFF_AGENT_ENABLED=maybe"], ["flags", "explode"]]) {
        const c = capture(work);
        expect(await runCli([...argv, "--state-dir", opsDir], c.io)).toBe(2);
      }
    });

    it("cache invalidate bumps the namespace generation", async () => {
      const dir = join(root, "cache-state");
      const c1 = capture(work);
      expect(await runCli(["cache", "invalidate", "--state-dir", dir], c1.io)).toBe(0);
      expect(c1.out()).toContain("v1.g0 -> v1.g1");
      const c2 = capture(work);
      expect(await runCli(["cache", "invalidate", "--state-dir", dir, "--json"], c2.io)).toBe(0);
      expect(JSON.parse(c2.out())).toEqual({ previous: "v1.g1", current: "v1.g2" });
      expect(await runCli(["cache", "--state-dir", dir], capture(work).io)).toBe(2);
    });

    it("policy status / rollback on an empty store", async () => {
      const dir = join(root, "policy-state");
      const s = capture(work);
      expect(await runCli(["policy", "status", "--state-dir", dir], s.io)).toBe(0);
      expect(s.out()).toContain("Production policy: none (deterministic defaults)");
      expect(s.out()).toContain("Staged: none");
      const r = capture(work);
      expect(await runCli(["policy", "rollback", "--state-dir", dir], r.io)).toBe(0);
      expect(r.out()).toContain("policy rollback: v0 -> none (deterministic defaults)");
      expect(await runCli(["policy", "dance"], capture(work).io)).toBe(2);
      expect(await runCli(["policy", "learn"], capture(work).io)).toBe(2);
    });
  });

  describe("independent CLI executable invocation", () => {
    it("executes dist/bin/eff-agent.js directly via child process (when built)", () => {
      const binScript = join(PKG, "dist", "bin", "eff-agent.js");
      if (!existsSync(binScript)) return;
      const versionOutput = execFileSync(NODE, [binScript, "--version"], { encoding: "utf8", env: minimalEnv() });
      expect(versionOutput.trim()).toBe("eff-agent 0.1.0");
      const helpOutput = execFileSync(NODE, [binScript, "--help"], { encoding: "utf8", env: minimalEnv() });
      expect(helpOutput).toContain("GraphFlow Efficiency Agent CLI");
    });
  });
});
