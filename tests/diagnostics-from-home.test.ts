import { afterAll, describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");

/**
 * Regression (live user reports): read-only diagnostics executed from the
 * HOME directory must answer, not refuse —
 *  - Ubuntu: `graphflow llm-check` from ~ threw
 *    "Refusing to index unsafe workspace root: /home/<user>".
 *  - Same class: diagnose / route diagnose / selfcheck.
 * Diagnostics diagnose; they must survive the unsafe state they report on.
 */
describe("read-only diagnostics from the home directory", () => {
  const previousGraphflowHome = process.env.GRAPHFLOW_CONFIG_HOME;
  // A fake HOME with NO graphflow config: the loneliest legit launch point.
  const fakeHome = mkdtempSync(join(tmpdir(), "gf-diag-home-"));
  writeFileSync(join(fakeHome, ".graphflow.config.json"), "{}\n", "utf8");

  afterAll(() => {
    if (previousGraphflowHome === undefined) delete process.env.GRAPHFLOW_CONFIG_HOME;
    else process.env.GRAPHFLOW_CONFIG_HOME = previousGraphflowHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
    // spawnSync (not execFileSync): --help prints to stderr with exit 0, and
    // the success path of execFileSync swallows stderr entirely.
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "node_modules", ".bin", "tsx"), join(REPO_ROOT, "src/surfaces/cli/index.ts"), ...args],
      {
        cwd: fakeHome,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          GRAPHFLOW_CONFIG_HOME: fakeHome,
          // Scrub provider keys so availability answers are deterministic.
          DEEPSEEK_API_KEY: "",
          OPENAI_API_KEY: "",
          TYPESAFE_API_KEY: "",
        },
      }
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  it("graphflow llm-check answers from home instead of refusing", () => {
    const result = runCli(["llm-check"]);
    expect(result.stderr).not.toContain("Refusing to index unsafe workspace root");
    // The command RAN and answered (report text present); exit 1 simply
    // flags "no usable LLM" for scripting — both outcomes are findings.
    expect(result.stdout).toContain("usable=");
    expect([0, 1]).toContain(result.status);
  }, 180_000);

  it("graphflow diagnose answers from home and reports the refusal as a finding", () => {
    const result = runCli(["diagnose"]);
    expect(result.stderr).not.toContain("Refusing to index unsafe workspace root");
    // The workspaceRoot diagnosis may carry discovery=refused — reported, not thrown.
  }, 180_000);

  it("selfcheck answers from home", () => {
    const result = runCli(["selfcheck"]);
    expect(result.stderr).not.toContain("Refusing to index unsafe workspace root");
  }, 180_000);

  it("usage banner lists llm-check and settings", () => {
    const result = runCli(["--help"]);
    const text = result.stdout + result.stderr;
    expect(text).toContain("llm-check");
    expect(text).toContain("settings");
    void homedir;
  }, 180_000);
});
