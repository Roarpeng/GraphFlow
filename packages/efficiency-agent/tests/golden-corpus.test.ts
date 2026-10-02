import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { COHORT_COMPOSITION, parseEffTaskCorpus, type EffTask } from "../src/corpus.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const CORPUS = join(PKG, "benchmarks", "golden-v1.jsonl");
const content = readFileSync(CORPUS, "utf8");
const { tasks, violations } = parseEffTaskCorpus(content);
const rawLines = content.split("\n").filter((l) => l.trim().length > 0);

const ID_PREFIX: Record<EffTask["cohort"], string> = {
  repetition: "rep-",
  regular: "reg-",
  complex: "cx-",
  failure: "fail-",
};

function gitAvailable(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

describe("golden-v1.jsonl corpus", () => {
  it("parses with 0 violations and exactly 50 tasks", () => {
    expect(violations).toEqual([]);
    expect(rawLines).toHaveLength(50);
    expect(tasks).toHaveLength(50);
  });

  it("ids are unique and carry their cohort prefix", () => {
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(50);
    for (const task of tasks) expect(task.id.startsWith(ID_PREFIX[task.cohort]), task.id).toBe(true);
  });

  it("cohort counts: 20 repetition / 15 regular / 10 complex / 5 failure", () => {
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[task.cohort] = (counts[task.cohort] ?? 0) + 1;
    expect(counts).toEqual({ repetition: 20, regular: 15, complex: 10, failure: 5 });
    expect(counts).toEqual(COHORT_COMPOSITION);
  });

  it("every task pins a 40-hex baseCommit", () => {
    for (const task of tasks) expect(task.baseCommit, task.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("every task text is a real sentence", () => {
    for (const task of tasks) expect(task.text.trim().length, task.id).toBeGreaterThanOrEqual(8);
  });

  it("every regex in files oracles compiles", () => {
    let count = 0;
    for (const task of tasks) {
      for (const file of task.oracle?.files ?? []) {
        expect(() => new RegExp(file.pattern), `${task.id}: ${file.pattern}`).not.toThrow();
        expect(file.path.length).toBeGreaterThan(0);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it("every overlayFrom has commands and non-empty paths", () => {
    let count = 0;
    for (const task of tasks) {
      const overlay = task.oracle?.overlayFrom;
      if (!overlay) continue;
      count += 1;
      expect(task.oracle?.commands?.length ?? 0, task.id).toBeGreaterThan(0);
      expect(overlay.paths.length, task.id).toBeGreaterThan(0);
      expect(overlay.commit, task.id).toMatch(/^[0-9a-f]{7,40}$/);
    }
    expect(count).toBeGreaterThan(0);
  });

  it("every present oracle is non-empty and uses known checks only", () => {
    const known = new Set(["outputAnyOf", "outputAllOf", "files", "commands", "overlayFrom", "refusal"]);
    for (const task of tasks) {
      if (!task.oracle) continue;
      const keys = Object.keys(task.oracle);
      expect(keys.length, task.id).toBeGreaterThan(0);
      for (const key of keys) expect(known.has(key), `${task.id}: ${key}`).toBe(true);
      for (const list of [task.oracle.outputAnyOf, task.oracle.outputAllOf, task.oracle.commands]) {
        if (list) expect(list.length, task.id).toBeGreaterThan(0);
      }
    }
  });

  it("failure cohort: refusal oracles (with signals and noChanges) or explicitly unjudged", () => {
    const failure = tasks.filter((t) => t.cohort === "failure");
    expect(failure).toHaveLength(5);
    for (const task of failure) {
      expect(task.category, task.id).toBe("deliberate-failure");
      if (task.oracle) {
        expect(task.oracle.refusal, task.id).toBeDefined();
        expect(task.oracle.refusal!.signals.length, task.id).toBeGreaterThan(0);
        expect(task.oracle.refusal!.noChanges, task.id).toBe(true);
      } else {
        expect(task.notes ?? "", `${task.id} must say why it is unjudged`).toMatch(/unjudged/i);
      }
    }
    expect(failure.filter((t) => t.oracle?.refusal).length).toBe(4);
  });

  it("tasks without an oracle say why they are unjudged (notes) or carry guards", () => {
    for (const task of tasks.filter((t) => !t.oracle)) {
      const explained = /unjudged|not auto-judged|design task/i.test(task.notes ?? "") || (task.guards?.length ?? 0) > 0;
      expect(explained, task.id).toBe(true);
    }
  });

  it("guards, where present, are non-empty command lists", () => {
    for (const task of tasks) {
      if (task.guards === undefined) continue;
      expect(task.guards.length, task.id).toBeGreaterThan(0);
      for (const g of task.guards) expect(g.trim().length, task.id).toBeGreaterThan(0);
    }
  });

  it("baseCommit (and overlay commits) exist in this repository when git is available", () => {
    if (!gitAvailable(PKG)) return;
    const shas = new Set<string>();
    for (const task of tasks) {
      if (task.baseCommit) shas.add(task.baseCommit);
      if (task.oracle?.overlayFrom) shas.add(task.oracle.overlayFrom.commit);
    }
    const missing: string[] = [];
    for (const sha of shas) {
      try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: PKG, stdio: "ignore", windowsHide: true });
      } catch {
        missing.push(sha);
      }
    }
    // A shallow clone legitimately lacks history; only assert in a full clone.
    let shallow = false;
    try {
      shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: PKG, encoding: "utf8", windowsHide: true }).trim() === "true";
    } catch {
      shallow = false;
    }
    if (!shallow) expect(missing).toEqual([]);
  }, 30_000);
});
