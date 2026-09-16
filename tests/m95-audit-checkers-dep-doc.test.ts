import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDependencyChecker } from "../src/audit/checkers/dependency-checker";
import { createDocConsistencyChecker } from "../src/audit/checkers/doc-consistency-checker";
import type { AuditContext } from "../src/audit/types";

const tempRoots: string[] = [];
function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeContext(): AuditContext {
  return { loadRules: () => ({ rules: [] }) };
}

function writeJson(root: string, name: string, value: unknown): void {
  writeFileSync(join(root, name), JSON.stringify(value, null, 2), "utf8");
}

describe("M95 dependency checker — npm", () => {
  it("v3 lock: dependency declared in package.json but absent from lock is an error", async () => {
    const root = makeTempRoot("gf-dep-");
    writeJson(root, "package.json", {
      name: "x",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.21", leftpad: "^1.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    });
    writeJson(root, "package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": {
          name: "x",
          version: "1.0.0",
          dependencies: { lodash: "^4.17.21" },
          devDependencies: { vitest: "^1.0.0" },
        },
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/vitest": { version: "1.0.0" },
      },
    });

    const findings = await createDependencyChecker().run([], root, makeContext());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "dependency-lock-missing:leftpad",
      kind: "dependency",
      severity: "error",
      evidence: { files: ["package.json", "package-lock.json"] },
    });
    expect(findings[0]?.message).toContain("leftpad");
    expect(findings[0]?.message).toContain("npm install");
    expect(findings[0]?.remediation).toContain("npm install");
  });

  it("v3 lock: nested scope copies (node_modules/<parent>/node_modules/<name>) count as present", async () => {
    const root = makeTempRoot("gf-dep-");
    writeJson(root, "package.json", {
      name: "x",
      dependencies: { lodash: "^4.17.21" },
    });
    writeJson(root, "package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": { name: "x", dependencies: { lodash: "^4.17.21" } },
        "node_modules/foo": { version: "1.0.0" },
        "node_modules/foo/node_modules/lodash": { version: "4.17.21" },
      },
    });

    expect(await createDependencyChecker().run([], root, makeContext())).toEqual([]);
  });

  it("v1 lock: flat top-level dependencies map is honored (compat + missing detection)", async () => {
    const root = makeTempRoot("gf-dep-");
    writeJson(root, "package.json", {
      name: "x",
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { vitest: "^1.0.0" },
    });
    writeJson(root, "package-lock.json", {
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.21", resolved: "https://example.invalid/lodash" },
        vitest: { version: "1.0.0", resolved: "https://example.invalid/vitest" },
      },
    });

    const checker = createDependencyChecker();
    expect(await checker.run([], root, makeContext())).toEqual([]);

    // Now add a manifest dep the v1 lock does not know about.
    writeJson(root, "package.json", {
      name: "x",
      dependencies: { lodash: "^4.17.21", leftpad: "^1.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    });
    const findings = await checker.run([], root, makeContext());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dependency-lock-missing:leftpad");
    expect(findings[0]?.severity).toBe("error");
  });

  it("v3 lock: root entry declaring a package.json-unknown dep is only a warning", async () => {
    const root = makeTempRoot("gf-dep-");
    writeJson(root, "package.json", {
      name: "x",
      dependencies: { lodash: "^4.17.21" },
    });
    writeJson(root, "package-lock.json", {
      lockfileVersion: 3,
      packages: {
        // leftpad sits in the lock root entry + node_modules, but package.json
        // no longer declares it — optional peer or stale lock, warning only.
        "": { name: "x", dependencies: { lodash: "^4.17.21", leftpad: "^1.0.0" } },
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/leftpad": { version: "1.0.0", peer: true, optional: true },
      },
    });

    const findings = await createDependencyChecker().run([], root, makeContext());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "dependency-lock-extra:leftpad",
      kind: "dependency",
      severity: "warning",
    });
    expect(findings[0]?.message).toContain("leftpad");
  });

  it("missing or malformed manifest/lock files fail open to []", async () => {
    const root = makeTempRoot("gf-dep-");
    const checker = createDependencyChecker();

    // No files at all.
    expect(await checker.run([], root, makeContext())).toEqual([]);

    // Valid lock, broken package.json.
    writeFileSync(join(root, "package.json"), "{ not json", "utf8");
    writeJson(root, "package-lock.json", { lockfileVersion: 3, packages: { "": {} } });
    expect(await checker.run([], root, makeContext())).toEqual([]);

    // Valid package.json, broken lock.
    writeJson(root, "package.json", { name: "x", dependencies: { lodash: "^4.17.21" } });
    writeFileSync(join(root, "package-lock.json"), "{ broken", "utf8");
    expect(await checker.run([], root, makeContext())).toEqual([]);

    // Lock present but with an unrecognized shape (no packages, no deps).
    writeJson(root, "package-lock.json", { lockfileVersion: 99 });
    expect(await checker.run([], root, makeContext())).toEqual([]);
  });
});

describe("M95 dependency checker — pip", () => {
  it("requirements.txt entries are checked against poetry.lock when it exists", async () => {
    const root = makeTempRoot("gf-pip-");
    writeFileSync(
      join(root, "requirements.txt"),
      "# core deps\nflask==2.3.2\nrequests==2.31.0\n-r other.txt\n-e .\n",
      "utf8"
    );
    writeFileSync(join(root, "poetry.lock"), '[package]\nname = "flask"\nversion = "2.3.2"\n', "utf8");

    const findings = await createDependencyChecker().run([], root, makeContext());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "dependency-lock-missing:requests",
      kind: "dependency",
      severity: "error",
      evidence: { files: ["requirements.txt", "poetry.lock"] },
    });
    expect(findings[0]?.message).toContain("requests");
    expect(findings[0]?.remediation).toContain("poetry");
  });

  it("requirements.txt with no poetry.lock/Pipfile.lock is skipped (no guessing)", async () => {
    const root = makeTempRoot("gf-pip-");
    writeFileSync(join(root, "requirements.txt"), "flask==2.3.2\n", "utf8");
    expect(await createDependencyChecker().run([], root, makeContext())).toEqual([]);
  });

  it("Pipfile.lock counts as a lock and quoted-name matching is containment-safe", async () => {
    const root = makeTempRoot("gf-pip-");
    writeFileSync(join(root, "requirements.txt"), "flask==2.3.2\nflask-cors==4.0.0\n", "utf8");
    // flask is recorded; flask-cors is not — "flask" must not match "flask-cors".
    writeJson(root, "Pipfile.lock", {
      _meta: { hash: { sha256: "deadbeef" } },
      default: { flask: { version: "==2.3.2" } },
    });

    const findings = await createDependencyChecker().run([], root, makeContext());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("dependency-lock-missing:flask-cors");
    expect(findings[0]?.remediation).toContain("pipenv");
  });
});

describe("M95 doc-consistency checker — CLI undocumented", () => {
  it("CLI entry change without any README/docs change is a warning", async () => {
    const root = makeTempRoot("gf-doc-");
    const findings = await createDocConsistencyChecker().run(
      ["src/surfaces/cli/commands/audit.ts", "src/core/other.ts"],
      root,
      makeContext()
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "doc-cli-undocumented",
      kind: "doc-consistency",
      severity: "warning",
    });
    expect(findings[0]?.message).toContain("README");
    expect(findings[0]?.evidence.files).toContain("src/surfaces/cli/commands/audit.ts");
    expect(findings[0]?.evidence.files).not.toContain("src/core/other.ts");
  });

  it("CLI change alongside docs or README changes stays quiet", async () => {
    const root = makeTempRoot("gf-doc-");
    const checker = createDocConsistencyChecker();
    expect(
      await checker.run(["src/surfaces/cli/main.ts", "docs/usage.md"], root, makeContext())
    ).toEqual([]);
    expect(
      await checker.run(["src/surfaces/cli/main.ts", "README.md"], root, makeContext())
    ).toEqual([]);
  });

  it("a changed file that package.json bin points at counts as CLI entry", async () => {
    const root = makeTempRoot("gf-doc-");
    writeJson(root, "package.json", { name: "x", version: "1.0.0", bin: { gf: "./bin/gf.js" } });
    const findings = await createDocConsistencyChecker().run(["bin/gf.js"], root, makeContext());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("doc-cli-undocumented");
  });
});

describe("M95 doc-consistency checker — version badge", () => {
  it("README npm badge lagging package.json version is an error; matching badge is quiet", async () => {
    const root = makeTempRoot("gf-doc-");
    writeJson(root, "package.json", { name: "x", version: "1.2.3" });
    writeFileSync(
      join(root, "README.md"),
      "# x\n\n![npm](https://img.shields.io/badge/npm-v0.9.0-blue)\n",
      "utf8"
    );
    const checker = createDocConsistencyChecker();

    const findings = await checker.run(["package.json"], root, makeContext());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "doc-version-badge:0.9.0",
      kind: "doc-consistency",
      severity: "error",
      evidence: { files: ["README.md", "package.json"] },
    });
    expect(findings[0]?.message).toContain("0.9.0");
    expect(findings[0]?.message).toContain("1.2.3");
    expect(findings[0]?.remediation).toContain("1.2.3");

    // Align the badge — the same change set becomes quiet.
    writeFileSync(
      join(root, "README.md"),
      "# x\n\n![npm](https://img.shields.io/badge/npm-v1.2.3-blue)\n",
      "utf8"
    );
    expect(await checker.run(["package.json"], root, makeContext())).toEqual([]);
  });

  it("missing badge or unreadable README/version skips the check", async () => {
    const root = makeTempRoot("gf-doc-");
    writeJson(root, "package.json", { name: "x", version: "1.2.3" });
    writeFileSync(join(root, "README.md"), "# x\n\nNo badge here.\n", "utf8");
    expect(
      await createDocConsistencyChecker().run(["package.json"], root, makeContext())
    ).toEqual([]);

    // README absent entirely.
    rmSync(join(root, "README.md"));
    expect(
      await createDocConsistencyChecker().run(["package.json"], root, makeContext())
    ).toEqual([]);
  });

  it("empty baseline (strategy none) runs only the stateful badge check", async () => {
    const root = makeTempRoot("gf-doc-");
    writeJson(root, "package.json", { name: "x", version: "1.2.3" });
    writeFileSync(
      join(root, "README.md"),
      "# x\n\n![npm](https://img.shields.io/badge/npm-v0.1.0-blue)\n",
      "utf8"
    );

    const findings = await createDocConsistencyChecker().run([], root, makeContext());
    expect(findings.map((f) => f.id)).toEqual(["doc-version-badge:0.1.0"]);
    expect(findings.some((f) => f.id === "doc-cli-undocumented")).toBe(false);

    // With a matching badge, an empty baseline produces nothing at all.
    writeFileSync(
      join(root, "README.md"),
      "# x\n\n![npm](https://img.shields.io/badge/npm-v1.2.3-blue)\n",
      "utf8"
    );
    expect(await createDocConsistencyChecker().run([], root, makeContext())).toEqual([]);
  });
});
