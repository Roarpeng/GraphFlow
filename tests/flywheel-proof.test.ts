import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FLYWHEEL_PROOF_STEPS,
  PROOF_USAGE,
  PUBLISHED_SELF_TEST_CLAIMS,
  REQUIRED_TRACKED_PATHS,
  buildDryProofSummary,
  formatHumanChecklist,
  parseProofArgs,
} from "../benchmarks/run-flywheel-proof";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function runProofCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/tsx/dist/cli.mjs"), "benchmarks/run-flywheel-proof.ts", ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GRAPHFLOW_SKIP_EMBEDDING_WARMUP: "1" },
    }
  );
}

describe("flywheel proof package", () => {
  it("exposes npm run proof:flywheel", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["proof:flywheel"]).toBe("tsx benchmarks/run-flywheel-proof.ts");
  });

  it("keeps the public package files on disk", () => {
    for (const rel of REQUIRED_TRACKED_PATHS) {
      expect(existsSync(join(ROOT, rel)), rel).toBe(true);
    }
    for (const step of FLYWHEEL_PROOF_STEPS) {
      expect(existsSync(join(ROOT, step.script)), step.script).toBe(true);
    }
  });

  it("parses --help / --dry-run / --json / --with-token / --output", () => {
    expect(parseProofArgs(["--help"]).help).toBe(true);
    expect(parseProofArgs(["-h"]).help).toBe(true);
    expect(parseProofArgs(["--dry"]).dryRun).toBe(true);
    expect(parseProofArgs(["--dry-run", "--json"]).jsonOnly).toBe(true);
    expect(parseProofArgs(["--with-token"]).withToken).toBe(true);
    expect(parseProofArgs(["--output", "tmp/out.json"]).outputPath).toBe("tmp/out.json");
    expect(parseProofArgs([]).dryRun).toBe(false);
    expect(parseProofArgs([]).help).toBe(false);
  });

  it("usage mentions the outsider command and dry/help flags", () => {
    expect(PROOF_USAGE).toContain("npm run proof:flywheel");
    expect(PROOF_USAGE).toContain("--help");
    expect(PROOF_USAGE).toContain("--dry-run");
    expect(PROOF_USAGE).toContain("docs/flywheel-reproduction.md");
  });

  it("published self-test claims still appear in their source markdown", () => {
    expect(PUBLISHED_SELF_TEST_CLAIMS.length).toBeGreaterThanOrEqual(7);
    for (const claim of PUBLISHED_SELF_TEST_CLAIMS) {
      const body = read(claim.sourceFile);
      expect(body, `${claim.id} missing ${claim.sourceNeedle}`).toContain(claim.sourceNeedle);
      expect(body).toContain(claim.display.split(" ")[0]);
    }
  });

  it("dry summary structurally passes and lists the checklist", () => {
    const summary = buildDryProofSummary();
    expect(summary.benchmark).toBe("flywheel-proof");
    expect(summary.schemaVersion).toBe(1);
    expect(summary.mode).toBe("dry-run");
    expect(summary.pass).toBe(true);
    expect(summary.structuralPass).toBe(true);
    expect(summary.claimMatch).toBeNull();
    expect(summary.liveMetrics).toBeNull();
    expect(summary.disclaimer).toMatch(/self-tests/i);
    expect(summary.reportIssueTitle).toMatch(/^\[benchmark\] Independent reproduction — /);
    expect(summary.docs).toContain("docs/flywheel-reproduction.md");
    expect(summary.steps.every((step) => step.skipped)).toBe(true);

    const text = formatHumanChecklist(summary);
    expect(text).toContain("Structural pass: YES");
    expect(text).toContain("Overall pass: YES");
    expect(text).toContain("[x] package.json script proof:flywheel");
    expect(text).toContain("What pass means");
  });

  it("CLI --help exits 0 and prints usage", () => {
    const result = runProofCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm run proof:flywheel");
    expect(result.stdout).toContain("--dry-run");
  });

  it("CLI --dry-run exits 0 and prints checklist + JSON", () => {
    const result = runProofCli(["--dry-run"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("GraphFlow flywheel proof");
    expect(result.stdout).toContain("Overall pass: YES");
    expect(result.stdout).toContain('"benchmark": "flywheel-proof"');
    expect(result.stdout).toContain('"mode": "dry-run"');
    expect(result.stdout).toContain('"pass": true');
    const jsonStart = result.stdout.indexOf("{");
    expect(jsonStart).toBeGreaterThan(-1);
    const parsed = JSON.parse(result.stdout.slice(jsonStart)) as {
      liveMetrics: unknown;
      publishedClaims: unknown[];
    };
    expect(parsed.liveMetrics).toBeNull();
    expect(parsed.publishedClaims.length).toBeGreaterThanOrEqual(7);
  });
});
