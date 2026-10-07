import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("security-audit script", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins the production advisories that npm audit --omit=dev currently reports", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    const agent = JSON.parse(
      readFileSync(join(process.cwd(), "packages/efficiency-agent/package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    // GHSA-6qxp-vccf-f47h: @modelcontextprotocol/sdk <1.31.0
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe("^1.32.1");
    expect(agent.dependencies["@modelcontextprotocol/sdk"]).toBe("^1.32.1");
    // GHSA-jqcg-44mw-7w3h: proxy-addr <2.0.8, still allowed by express's ^2.0.7
    expect(pkg.overrides["proxy-addr"]).toBe("^2.0.8");
  });

  it("imports join from node:path so the scheduled audit can start", () => {
    const src = readFileSync(join(process.cwd(), "scripts/security-audit.cjs"), "utf8");
    expect(src).toMatch(/require\(["']node:path["']\)/);
    expect(src).toMatch(/\{[^}]*\bjoin\b[^}]*\}\s*=\s*require\(["']node:path["']\)/);
    expect(src).toContain('const root = join(__dirname, "..")');
    expect(src).toContain("cwd: root");
    expect(src).toContain('shell: process.platform === "win32"');
  });

  it("writes JSON to a nested report path without ReferenceError", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-audit-"));
    temps.push(root);
    const bin = join(root, "bin");
    const report = join(root, "nested", "report.json");
    mkdirSync(bin, { recursive: true });
    const payload = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} });
    writeFileSync(
      join(bin, "npm.js"),
      `process.stdout.write(${JSON.stringify(payload)});\nprocess.exit(0);\n`
    );
    writeFileSync(join(bin, "npm"), "#!/usr/bin/env node\nrequire(\"./npm.js\");\n");
    writeFileSync(join(bin, "npm.cmd"), "@echo off\r\nnode \"%~dp0npm.js\" %*\r\n");
    chmodSync(join(bin, "npm"), 0o755);

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts/security-audit.cjs"), "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          GRAPHFLOW_SECURITY_REPORT: report,
        },
        timeout: 15_000,
      }
    );

    expect(result.stderr ?? "").not.toMatch(/join is not defined/);
    expect(
      result.status,
      `stderr=${result.stderr ?? ""} error=${result.error?.message ?? ""}`
    ).toBe(0);
    expect(readFileSync(report, "utf8")).toBe(payload);
  });
});
