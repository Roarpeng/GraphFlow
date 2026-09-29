import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * stdout is the machine-readable channel. Anything else a script might read
 * there — a usage banner, a diagnostic — has to go to stderr, or a consumer
 * piping `graphflow --json` into a JSON parser gets prose where it expects a
 * result object.
 */
const CLI = join(__dirname, "..", "src", "surfaces", "cli", "index.ts");

function runCli(args: string[]): { stdout: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    [join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), CLI, ...args],
    { encoding: "utf8", timeout: 120_000 }
  );
  return { stdout: result.stdout ?? "", status: result.status };
}

describe("CLI stdout hygiene", () => {
  it("keeps the usage banner off stdout for an unknown command", () => {
    const { stdout, status } = runCli(["definitely-not-a-command"]);

    // Before this, an unknown command printed the full usage text into stdout
    // while exiting non-zero, so a script could not distinguish "the tool
    // explained itself" from "the tool produced a result".
    expect(stdout.trim()).toBe("");
    expect(status).toBe(1);
  });

  it("keeps --help off stdout too", () => {
    const { stdout } = runCli(["--help"]);
    expect(stdout.trim()).toBe("");
  });

  it("still emits parseable JSON on stdout for a real --json command", () => {
    const { stdout } = runCli(["doctor", "--json"]);
    expect(stdout.trim()).not.toBe("");
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
