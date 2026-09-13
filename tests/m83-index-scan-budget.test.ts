import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBatchReferenceEdges,
  buildSingleFileReferenceEdges,
  type IndexedSymbol,
} from "../src/graph/file-indexer-edges";
import {
  isGeneratedOrLockFile,
  normalizePath,
  walkFiles,
  walkScannableFiles,
} from "../src/graph/file-indexer-walker";
import type { ParsedFile } from "../src/graph/file-indexer-types";

/**
 * M83 — large-project indexing scan budget.
 *
 * Measured on a 5.5k-file Python/Go repo: 5.75M reference edges came from 18.7k
 * names, `__init__` alone contributing 469k edges (defined in 414 files). Those
 * generic-name edges are noise and are what makes big workspaces slow to index.
 * The DF budget prunes them; the per-file cap bounds the long tail; the walker
 * stops indexing git-ignored and machine-generated files.
 */

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** walkFiles returns absolute paths; compare repo-relative POSIX like walkScannableFiles. */
function repoRel(root: string, absPath: string): string {
  return normalizePath(relative(root, absPath));
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function parsedFile(relPath: string, content: string, declared: IndexedSymbol[] = []): ParsedFile {
  return {
    relPath,
    fileNodeId: `file:${relPath}`,
    content,
    scannable: true,
    declared,
    calls: [],
    inherits: [],
  } as unknown as ParsedFile;
}

const symbol = (relPath: string, name: string): IndexedSymbol =>
  ({ nodeId: `symbol:${relPath}:${name}`, name, file: relPath }) as unknown as IndexedSymbol;

describe("M83 reference edge budget", () => {
  it("drops names defined across too many files (document-frequency pruning)", () => {
    const parsed = [parsedFile("src/app.ts", "common() and rare() called here")];
    const symbolIndex = new Map<string, IndexedSymbol[]>([
      // "common" is defined in three files, "rare" in one.
      ["common", [symbol("src/a.ts", "common"), symbol("src/b.ts", "common"), symbol("src/c.ts", "common")]],
      ["rare", [symbol("src/d.ts", "rare")]],
    ]);

    const unbounded = buildBatchReferenceEdges(parsed, symbolIndex, { maxDefinitionFiles: 0 });
    expect(unbounded.edges).toHaveLength(4); // 1 file x (3 common + 1 rare)

    const pruned = buildBatchReferenceEdges(parsed, symbolIndex, { maxDefinitionFiles: 2 });
    expect(pruned.edges).toHaveLength(1);
    expect(pruned.edges[0]?.to).toBe("symbol:src/d.ts:rare");
    expect(pruned.referenceCount).toBe(1);
    expect(pruned.skippedCommonNames).toBe(1);
  });

  it("caps reference edges per source file", () => {
    const names = Array.from({ length: 20 }, (_, i) => `name${i}`);
    const parsed = [parsedFile("src/app.ts", names.map((n) => `${n}()`).join(" "))];
    const symbolIndex = new Map<string, IndexedSymbol[]>(
      names.map((n) => [n, [symbol("src/defs.ts", n)]])
    );

    const capped = buildBatchReferenceEdges(parsed, symbolIndex, { maxEdgesPerFile: 5 });
    expect(capped.edges).toHaveLength(5);
    expect(capped.cappedFiles).toBe(1);

    const unlimited = buildBatchReferenceEdges(parsed, symbolIndex, { maxEdgesPerFile: 0 });
    expect(unlimited.edges).toHaveLength(20);
  });

  it("applies the same budget to the incremental (single-file) builder", () => {
    const snapshotNodes = [
      { id: "symbol:src/a.ts:1", type: "Symbol", metadata: { name: "common", file: "src/a.ts" } },
      { id: "symbol:src/b.ts:2", type: "Symbol", metadata: { name: "common", file: "src/b.ts" } },
      { id: "symbol:src/c.ts:3", type: "Symbol", metadata: { name: "common", file: "src/c.ts" } },
      { id: "symbol:src/d.ts:4", type: "Symbol", metadata: { name: "rare", file: "src/d.ts" } },
    ] as unknown as Parameters<typeof buildSingleFileReferenceEdges>[4];

    const unbounded = buildSingleFileReferenceEdges(
      "file:src/app.ts", "src/app.ts", "common() rare()", [], snapshotNodes, {}
    );
    expect(unbounded.edges).toHaveLength(4);

    const pruned = buildSingleFileReferenceEdges(
      "file:src/app.ts", "src/app.ts", "common() rare()", [], snapshotNodes,
      { maxDefinitionFiles: 2 }
    );
    expect(pruned.edges.map((edge) => edge.to)).toEqual(["symbol:src/d.ts:4"]);
    expect(pruned.skippedCommonNames).toBe(1);
  });
});

describe("M83 walker skip rules", () => {
  it("detects lockfiles, minified bundles, source maps and generated bindings", () => {
    for (const name of [
      "package-lock.json",
      "yarn.lock",
      "poetry.lock",
      "go.sum",
      "app.min.js",
      "styles.min.css",
      "bundle.bundle.js",
      "index.js.map",
      "service_pb2.py",
      "service_pb2_grpc.py",
      "api.pb.go",
      "model.g.dart",
      "widget.designer.cs",
      "client.generated.ts",
    ]) {
      expect(isGeneratedOrLockFile(name), name).toBe(true);
    }
    for (const name of ["app.js", "index.ts", "lock.ts", "my.summary.md", "generated.ts"]) {
      expect(isGeneratedOrLockFile(name), name).toBe(false);
    }
  });

  it("skips generated/lock files even outside a git checkout", () => {
    const root = makeTempDir("gf-m83-nogit-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    writeFileSync(join(root, "app.min.js"), "var a=1;\n");

    const found = walkFiles(root, [".ts", ".js", ".json"]).map((p) => repoRel(root, p));

    expect(found).toEqual(["src/app.ts"]);
  });

  it("honours .gitignore via git ls-files, and can be disabled", () => {
    const root = makeTempDir("gf-m83-git-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
    } catch {
      return; // git unavailable in this environment: nothing to assert
    }
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "generated/\n*.local.ts\n");
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "secrets.local.ts"), "export const s = 1;\n");
    writeFileSync(join(root, "generated", "client.ts"), "export const c = 1;\n");

    const respected = walkFiles(root, [".ts"]).map((p) => repoRel(root, p));
    expect(respected).toEqual(["src/app.ts"]);

    const disabled = walkFiles(root, [".ts"], { respectGitIgnore: false })
      .map((p) => repoRel(root, p))
      .sort();
    expect(disabled).toEqual(["generated/client.ts", "src/app.ts", "src/secrets.local.ts"]);

    // walkScannableFiles must scan exactly the same set as walkFiles.
    const scanned = walkScannableFiles(root, [".ts"], 200_000).map((file) => file.relPath);
    expect(scanned).toEqual(["src/app.ts"]);
  });
});
