import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUnsafeWorkspaceFallback } from "../src/config/discover-workspace";
import { installProjectGeminiInstructions, installProjectLevelRules } from "../src/integrations/skill-installer";

/**
 * Running `graphflow install` from the home directory used to scatter project
 * files across it. Observed on both Ubuntu and Windows: every "project" target
 * resolved to `$HOME`, and one of those writers is a plain copy with no
 * managed-block markers, so it overwrote a marker-ful instruction file with a
 * bare AGENTS.md copy. `install` then reported "already up to date" while
 * `doctor` reported the same file as `missing` — one file, two opposite
 * verdicts, and no way for the user to tell which to believe.
 *
 * The graph index already refuses an unsafe root ("Refusing to use unsafe
 * workspace root"). Project files have to refuse it too.
 */
const tempRoots: string[] = [];
let previousHome: string | undefined;

function sandbox(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  previousHome = process.env.HOME;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("project-level rules refuse a home-directory root", () => {
  it("writes nothing when the workspace root is the home directory", () => {
    const home = sandbox("gf-home-root-");
    process.env.HOME = home;

    const results = installProjectLevelRules(home, undefined, () => {});

    // Every target reports the reason rather than a silent success, so a user
    // reading `graphflow install` output can see why the files were not written.
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.status === "skipped")).toBe(true);
    expect(results.every((r) => /home directory is not a project root/.test(r.message ?? ""))).toBe(true);

    // The concrete damage: a marker-ful file must not be replaced by a bare copy.
    expect(existsSync(join(home, ".claude", "rules", "graphflow.md"))).toBe(false);
    expect(existsSync(join(home, ".windsurfrules"))).toBe(false);
  });

  it("still writes into a real project directory", () => {
    const home = sandbox("gf-home-ok-");
    const project = sandbox("gf-project-");
    process.env.HOME = home;

    const results = installProjectLevelRules(project, undefined, () => {});
    const wrote = results.filter((r) => r.status === "created" || r.status === "updated");

    // Some targets have no vendored source and legitimately skip; what matters
    // is that the guard did not blank the whole batch.
    expect(wrote.length + results.filter((r) => r.status === "skipped" && /not found/i.test(r.message ?? "")).length)
      .toBe(results.length);
    expect(results.every((r) => !/home directory is not a project root/.test(r.message ?? ""))).toBe(true);
  });

  it("leaves an existing marker-ful instruction file intact when run from home", () => {
    const home = sandbox("gf-home-intact-");
    process.env.HOME = home;
    const rulesDir = join(home, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });
    const instruction = join(rulesDir, "graphflow.md");
    const marked = [
      "# mine",
      "<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->",
      "keep me",
      "<!-- GRAPHFLOW:END -->",
      "",
    ].join("\n");
    writeFileSync(instruction, marked, "utf8");

    installProjectLevelRules(home, undefined, () => {});

    // The regression in one assertion: this file used to be overwritten with a
    // bare AGENTS.md copy, which made doctor report it missing.
    expect(readFileSync(instruction, "utf8")).toBe(marked);
  });
});

describe("project GEMINI.md refuses a home-directory root", () => {
  // A second writer, found by auditing what actually landed in a home directory
  // after running install from `~`: a 1.6 KB `~/GEMINI.md`. Guarding only the
  // rule-file writer would have left this one scattering files, which is the
  // shape of fix that looks complete and is not.
  it("does not write ~/GEMINI.md", () => {
    const home = sandbox("gf-gemini-home-");
    process.env.HOME = home;

    const results = installProjectGeminiInstructions(home);

    expect(results[0].status).toBe("skipped");
    expect(results[0].message).toMatch(/home directory is not a project root/);
    expect(existsSync(join(home, "GEMINI.md"))).toBe(false);
  });

  it("still writes GEMINI.md into a real project", () => {
    const home = sandbox("gf-gemini-ok-");
    const project = sandbox("gf-gemini-project-");
    process.env.HOME = home;

    const results = installProjectGeminiInstructions(project);

    expect(results[0].status).toBe("created");
    expect(existsSync(join(project, "GEMINI.md"))).toBe(true);
  });
});

describe("the real home directory is treated as unsafe", () => {
  it("is recognised as a home root, not as a project", () => {
    // Guards the premise of the tests above: if homedir() stopped being
    // recognised as unsafe, the guard would silently stop protecting anything.
    expect(isUnsafeWorkspaceFallback(homedir())).toBe(true);
  });
});
