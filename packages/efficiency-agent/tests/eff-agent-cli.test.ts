import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFlags, runCli, type CliIo } from "../bin/eff-agent.js";

function createCaptureIo(): { io: Required<CliIo>; getOut: () => string; getErr: () => string } {
  let stdoutBuf = "";
  let stderrBuf = "";
  return {
    io: {
      stdout: (msg: string) => {
        stdoutBuf += msg + "\n";
      },
      stderr: (msg: string) => {
        stderrBuf += msg + "\n";
      },
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    },
    getOut: () => stdoutBuf,
    getErr: () => stderrBuf,
  };
}

describe("eff-agent CLI (HTML §12, §25)", () => {
  const corpusFile = join(__dirname, "../benchmarks/eff-tasks-v1.jsonl");

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
      ]);

      expect(positional).toEqual(["run", "my task"]);
      expect(flags.mode).toBe("shadow");
      expect(flags.worker).toBe("external");
      expect(flags.policy).toBe("adaptive");
      expect(flags.limit).toBe(10);
      expect(flags.json).toBe(true);
      expect(flags.validation).toEqual(["node -e '1'", "node -e '2'"]);
    });

    it("parses version and help flags", () => {
      const { flags: f1 } = parseFlags(["--version"]);
      expect(f1.version).toBe(true);

      const { flags: f2 } = parseFlags(["-h"]);
      expect(f2.help).toBe(true);
    });
  });

  describe("eff-agent run", () => {
    it("errors when task argument is missing", async () => {
      const { io, getErr } = createCaptureIo();
      const code = await runCli(["run"], io);
      expect(code).toBe(2);
      expect(getErr()).toContain("missing required argument <task>");
    });

    it("executes run in advisory mode without executing worker", async () => {
      const { io, getOut } = createCaptureIo();
      const code = await runCli(["run", "Inspect routing table", "--mode=advisory"], io);
      expect(code).toBe(0);
      const out = getOut();
      expect(out).toContain("=== Efficiency Agent Advisory ===");
      expect(out).toContain("Inspect routing table");
      expect(out).toContain("Reuse Mode: FRESH");
    });

    it("executes run in advisory mode with --json", async () => {
      const { io, getOut } = createCaptureIo();
      const code = await runCli(["run", "Inspect routing table", "--mode=advisory", "--json"], io);
      expect(code).toBe(0);
      const json = JSON.parse(getOut());
      expect(json.mode).toBe("advisory");
      expect(json.task).toBe("Inspect routing table");
      expect(json.decision.reuseMode).toBe("FRESH");
    });

    it("executes run with broker and local worker successfully", async () => {
      const { io, getOut } = createCaptureIo();
      const code = await runCli(
        [
          "run",
          "Simple test task",
          "--mode=broker",
          "--worker=local",
          "--policy=conservative",
          `--validation=${process.execPath} -e "process.exit(0)"`,
        ],
        io
      );
      expect(code).toBe(0);
      const out = getOut();
      expect(out).toContain("=== Efficiency Agent Run ===");
      expect(out).toContain("Status: completed");
      expect(out).toContain("Validation Passed: true");
    });

    it("executes run in shadow mode showing advisory and broker result", async () => {
      const { io, getOut } = createCaptureIo();
      const code = await runCli(
        [
          "run",
          "Shadow task",
          "--mode=shadow",
          "--worker=local",
          `--validation=${process.execPath} -e "process.exit(0)"`,
        ],
        io
      );
      expect(code).toBe(0);
      const out = getOut();
      expect(out).toContain("[Shadow Advisory]");
      expect(out).toContain("Status: completed");
    });

    it("executes run with external worker", async () => {
      const { io, getOut } = createCaptureIo();
      const code = await runCli(
        [
          "run",
          "External worker task",
          "--worker=external",
          `--cli-command=${process.execPath}`,
          `-e 'console.log("ext cli ran"); process.exit(0);'`,
        ],
        io
      );
      expect(code).toBe(0);
      const out = getOut();
      expect(out).toContain("Worker: external-cli:");
      expect(out).toContain("Status: completed");
    });

    it("returns exit code 1 when broker validation fails", async () => {
      const { io, getOut } = createCaptureIo();
      const code = await runCli(
        [
          "run",
          "Failing task",
          "--mode=broker",
          "--worker=local",
          `--validation=${process.execPath} -e "process.exit(1)"`,
        ],
        io
      );
      expect(code).toBe(1);
      const out = getOut();
      expect(out).toContain("Status: failed");
      expect(out).toContain("Validation Passed: false");
    });
  });

  describe("eff-agent bench run & compare", () => {
    it("bench run fails if corpus file is missing", async () => {
      const { io, getErr } = createCaptureIo();
      const code = await runCli(["bench", "run"], io);
      expect(code).toBe(2);
      expect(getErr()).toContain("missing required argument <tasks.jsonl>");
    });

    it("bench run executes benchmark on corpus and produces valid JSONL trace", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "eff-cli-test-"));
      try {
        const outBase = join(tmp, "baseline.jsonl");
        const outShadow = join(tmp, "shadow.jsonl");

        // 1. Run baseline benchmark
        const { io: io1, getOut: out1 } = createCaptureIo();
        const code1 = await runCli(
          ["bench", "run", corpusFile, "--mode=baseline", `--out=${outBase}`, "--limit=3"],
          io1
        );
        expect(code1).toBe(0);
        expect(out1()).toContain("Tasks Run: 3");
        expect(out1()).toContain("Provenance Contract: CLEAN (0 violations)");
        expect(existsSync(outBase)).toBe(true);

        // 2. Run shadow benchmark
        const { io: io2, getOut: out2 } = createCaptureIo();
        const code2 = await runCli(
          ["bench", "run", corpusFile, "--mode=shadow", `--out=${outShadow}`, "--limit=3"],
          io2
        );
        expect(code2).toBe(0);
        expect(out2()).toContain("Tasks Run: 3");
        expect(out2()).toContain("Provenance Contract: CLEAN (0 violations)");
        expect(existsSync(outShadow)).toBe(true);

        // 3. Compare baseline vs shadow
        const { io: io3, getOut: out3 } = createCaptureIo();
        const code3 = await runCli(["bench", "compare", outBase, outShadow], io3);
        expect(code3).toBe(0);
        const report = out3();
        expect(report).toContain("=== Efficiency Benchmark Comparison ===");
        expect(report).toContain("Tasks Compared: 3");
        expect(report).toContain("Baseline:");
        expect(report).toContain("Shadow:");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("bench compare REFUSES comparison when measurement contract is violated (gate)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "eff-cli-gate-"));
      try {
        const outBase = join(tmp, "base-valid.jsonl");
        const outViolated = join(tmp, "shadow-violated.jsonl");

        // Generate a valid trace
        const { io: io1 } = createCaptureIo();
        await runCli(
          ["bench", "run", corpusFile, "--mode=baseline", `--out=${outBase}`, "--limit=1"],
          io1
        );

        // Create an invalid trace that breaks Measurement Contract R3 (missing method on estimated)
        const validTrace = JSON.parse(readFileSync(outBase, "utf8").trim());
        const invalidTrace = {
          ...validTrace,
          llm: {
            calls: {
              value: 5,
              provenance: "estimated",
              // Violates R3: estimated requires method
            },
          },
        };
        writeFileSync(outViolated, JSON.stringify(invalidTrace) + "\n", "utf8");

        const { io: io2, getErr: err2 } = createCaptureIo();
        const code = await runCli(["bench", "compare", outBase, outViolated], io2);

        expect(code).toBe(1);
        const errText = err2();
        expect(errText).toContain("compare REFUSED — measurement contract violations:");
        expect(errText).toContain("shadow[0]:");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("independent CLI executable invocation", () => {
    it("executes dist/bin/eff-agent.js directly via child process", () => {
      const binScript = join(__dirname, "../dist/bin/eff-agent.js");
      if (!existsSync(binScript)) {
        return; // Built binary not present in pure dev mode
      }

      const versionOutput = execFileSync(process.execPath, [binScript, "--version"], {
        encoding: "utf8",
      });
      expect(versionOutput.trim()).toBe("eff-agent 0.1.0");

      const helpOutput = execFileSync(process.execPath, [binScript, "--help"], {
        encoding: "utf8",
      });
      expect(helpOutput).toContain("GraphFlow Efficiency Agent CLI");
    });
  });
});
