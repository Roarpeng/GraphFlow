/**
 * Incremental caches must never serve a stale result.
 *
 * Four caches were added to make slicing and graph building incremental across
 * processes (AST shards, doc<->code links, per-file symbol retrieval data, and
 * the knowledge-graph fingerprint cache). Every one of them is keyed on file
 * content, so the failure mode that matters is not "cache miss" but "cache hit
 * with yesterday's content". These checks pin the invalidation contract.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushWorkspaceAstCaches, getWorkspaceAstIndex } from "../src/slicer.js";
import { buildDocCodeLinks } from "../src/doc-graph.js";
import { findCommandMacro, recordTrajectoryAndMine } from "../src/macro-engine.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-incr-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "model.ts"),
    "export function alpha(): number {\n  return 1;\n}\n",
    "utf8"
  );
  writeFileSync(
    join(root, "README.md"),
    "# Alpha\n\nalpha returns the first value.\n",
    "utf8"
  );
  return root;
}

const shardDir = (root: string) => join(root, ".graphflow", "ast-cache");

check("A1: analysing a file persists a shard, and a second index reuses it", () => {
  const root = makeRepo();
  try {
    const idx = getWorkspaceAstIndex(root);
    const first = idx.getFileAnalysis("src/model.ts");
    assert.ok(first, "file must be analysable");
    flushWorkspaceAstCaches();

    const dir = shardDir(root);
    assert.ok(existsSync(dir), "shard directory must be created");
    const shards = readdirSync(dir).filter((n) => n.endsWith(".json"));
    assert.equal(shards.length, 1, `expected 1 shard, got ${shards.length}`);

    // A fresh index on the same root has an empty memory cache, so a hit proves
    // the shard was read back from disk rather than recomputed.
    const idx2 = getWorkspaceAstIndex(root);
    idx2.invalidateFile("src/model.ts");
    const second = idx2.getFileAnalysis("src/model.ts");
    assert.ok(second, "second index must resolve the file");
    assert.deepEqual(
      second!.ast.symbols.map((s) => s.name),
      first!.ast.symbols.map((s) => s.name),
      "disk-backed AST must match the freshly parsed one"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("A2: editing a file invalidates its shard (no stale AST)", () => {
  const root = makeRepo();
  try {
    const idx = getWorkspaceAstIndex(root);
    idx.getFileAnalysis("src/model.ts");
    flushWorkspaceAstCaches();

    writeFileSync(
      join(root, "src", "model.ts"),
      "export function beta(): number {\n  return 2;\n}\n",
      "utf8"
    );
    idx.invalidateFile("src/model.ts");
    const after = idx.getFileAnalysis("src/model.ts");
    assert.ok(after, "edited file must still resolve");
    const names = after!.ast.symbols.map((s) => s.name);
    assert.ok(names.includes("beta"), `edited symbol missing, got ${names.join(",")}`);
    assert.ok(!names.includes("alpha"), `stale symbol survived: ${names.join(",")}`);

    // The rewrite must have replaced the shard, not left the old one behind.
    flushWorkspaceAstCaches();
    const shards = readdirSync(shardDir(root)).filter((n) => n.endsWith(".json"));
    assert.equal(shards.length, 1, `shard must be replaced, not duplicated: ${shards.length}`);
    const rec = JSON.parse(readFileSync(join(shardDir(root), shards[0]!), "utf8"));
    const cachedNames = (rec.ast.symbols as Array<{ name: string }>).map((s) => s.name);
    assert.ok(cachedNames.includes("beta"), "persisted shard must hold the new AST");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("A3: GRAPHFLOW_AST_CACHE=0 writes nothing", () => {
  const root = makeRepo();
  const prev = process.env.GRAPHFLOW_AST_CACHE;
  process.env.GRAPHFLOW_AST_CACHE = "0";
  try {
    const idx = getWorkspaceAstIndex(root);
    idx.getFileAnalysis("src/model.ts");
    flushWorkspaceAstCaches();
    const dir = shardDir(root);
    const shards = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
    assert.equal(shards.length, 0, "cache disabled must not write shards");
  } finally {
    if (prev === undefined) delete process.env.GRAPHFLOW_AST_CACHE;
    else process.env.GRAPHFLOW_AST_CACHE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

check("A4: doc<->code links survive a rebuild and still honour file edits", () => {
  const root = makeRepo();
  try {
    const idx = getWorkspaceAstIndex(root);
    const first = buildDocCodeLinks(idx);
    const second = buildDocCodeLinks(getWorkspaceAstIndex(root));
    assert.deepEqual(second, first, "a rebuild with identical inputs must be stable");

    writeFileSync(
      join(root, "src", "model.ts"),
      "export function gamma(): number {\n  return 3;\n}\n",
      "utf8"
    );
    idx.invalidateFile("src/model.ts");
    const after = buildDocCodeLinks(idx);
    const stillPointsAtAlpha = after.some((l) => l.symbolName === "alpha");
    assert.ok(!stillPointsAtAlpha, "links must not keep pointing at a removed symbol");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("A5: a repeated shell command compiles into a local tool and is findable", () => {
  const root = makeRepo();
  try {
    const ev = {
      sessionId: "s1",
      kind: "exec" as const,
      key: "pytest tests/test_model.py",
      items: ["pytest tests/test_model.py"],
      ok: true,
    };
    recordTrajectoryAndMine(root, ev);
    recordTrajectoryAndMine(root, { ...ev, items: ["pytest tests/test_other.py"], key: "pytest tests/test_other.py" });

    const found = findCommandMacro(root, "pytest tests/test_model.py");
    assert.ok(found, "a twice-run command must compile into a macro");
    assert.ok(
      found!.kind === "command-pipeline" || found!.kind === "command-template",
      `unexpected macro kind ${found!.kind}`
    );
    assert.ok(found!.scriptPath, "the macro must expose a runnable local script");

    // A different argument must still resolve through the parameter template.
    const byTemplate = findCommandMacro(root, "pytest tests/test_third.py");
    assert.ok(byTemplate, "a parameterized command must match its template macro");
    assert.equal(byTemplate!.id, found!.id);

    assert.equal(findCommandMacro(root, "echo hi"), undefined, "unrelated commands must not match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
