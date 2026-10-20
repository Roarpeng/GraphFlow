/**
 * GraphFlow — Regression tests for knowledge-graph quality fixes.
 *
 * Covers:
 *  (a) brief in-degree uses real path resolution, so same-named `index.ts` files in different
 *      directories no longer cross-contaminate each other's counts;
 *  (b) a generic call (`get`/`has`/`request`/...) with an unresolved receiver is not bound to a
 *      same-named workspace symbol, while a type-resolved call still is;
 *  (c) a `doc-links-code` edge is emitted only when the target symbol is literally present in the
 *      corresponding document section (case-sensitive, identifier boundary).
 *
 * Self-contained: temp dirs only. Exits non-zero on failure.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildKnowledgeGraphData,
  generateCrossAgentBrief,
  getWorkspaceAstIndex,
} from "../src/index.js";

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, ...relPath.split("/"));
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function runCase(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS [fix-graph] ${name}`);
  } catch (error) {
    console.error(`FAIL [fix-graph] ${name}`);
    throw error;
  }
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), "gf-fix-graph-"));

  try {
    // ── (a) Same-named index files in different directories ──
    writeFile(root, "pkg/a/index.ts", `export const a = 1;\n`);
    writeFile(root, "pkg/b/index.ts", `export const b = 2;\n`);
    writeFile(root, "app/one.ts", `import { a } from "../pkg/a/index";\nexport const one = a;\n`);
    writeFile(root, "app/two.ts", `import { b } from "../pkg/b/index";\nexport const two = b;\n`);

    runCase("index in-degree is resolved per directory", () => {
      const brief = generateCrossAgentBrief(getWorkspaceAstIndex(root));
      assert.match(
        brief,
        /- pkg\/a\/index\.ts \(imported by 1 file\(s\)\)/,
        "pkg/a/index.ts must have exactly one importer"
      );
      assert.match(
        brief,
        /- pkg\/b\/index\.ts \(imported by 1 file\(s\)\)/,
        "pkg/b/index.ts must have exactly one importer"
      );
      assert.doesNotMatch(
        brief,
        /pkg\/(?:a|b)\/index\.ts \(imported by 2 file\(s\)\)/,
        "same-named index files must not inherit each other's importers"
      );
    });

    // ── (b) Generic calls with an unresolved receiver must not be guessed ──
    writeFile(
      root,
      "src/alpha.ts",
      `export class Alpha {\n  get(key: string): string {\n    return key;\n  }\n}\n`
    );
    writeFile(
      root,
      "src/beta.ts",
      `export class Beta {\n  get(key: string): string {\n    return key;\n  }\n}\n`
    );
    writeFile(
      root,
      "src/caller.ts",
      [
        `import { Alpha } from "./alpha";`,
        ``,
        `export function unknownReceiver(headers: any): string {`,
        `  return headers.get("content-type");`,
        `}`,
        ``,
        `export function knownReceiver(alpha: Alpha): string {`,
        `  return alpha.get("x");`,
        `}`,
        ``,
      ].join("\n")
    );

    runCase("ambiguous generic calls are not bound", () => {
      const index = getWorkspaceAstIndex(root);
      index.getFiles(true); // the shared index caches directory scans for 5s
      const graph = buildKnowledgeGraphData(index);
      const callEdges = graph.edges.filter((edge) => edge.kind === "calls");
      assert.ok(
        !callEdges.some(
          (edge) =>
            edge.source.includes("unknownReceiver") &&
            (edge.target.endsWith("#Alpha.get") || edge.target.endsWith("#Beta.get"))
        ),
        "headers.get() must not bind to Alpha.get/Beta.get"
      );
      assert.ok(
        callEdges.some(
          (edge) =>
            edge.source.includes("knownReceiver") && edge.target.endsWith("#Alpha.get")
        ),
        "a receiver with a known workspace type must still produce a call edge"
      );
    });

    // ── (c) Doc edges require a literal identifier in the matching section ──
    writeFile(
      root,
      "src/symbols.ts",
      `export function presentSymbol(): number {\n  return 1;\n}\n\nexport const absentSymbol = 2;\n`
    );
    writeFile(
      root,
      "docs/spec.md",
      [
        `# Symbol reference`,
        ``,
        "`presentSymbol` is the authoritative example.",
        "",
        "The `absent_symbol` spelling is mentioned here on purpose.",
        "",
      ].join("\n")
    );

    runCase("doc links require a literal target identifier", () => {
      const index = getWorkspaceAstIndex(root);
      index.getFiles(true);
      const graph = buildKnowledgeGraphData(index);
      const docEdges = graph.edges.filter((edge) => edge.kind === "doc-links-code");
      assert.ok(
        docEdges.some((edge) => edge.target.endsWith("#presentSymbol")),
        "presentSymbol is literally mentioned and must stay linked"
      );
      assert.ok(
        !docEdges.some((edge) => edge.target.endsWith("#absentSymbol")),
        "absentSymbol is only a normalization collision (`absent_symbol`) and must be dropped"
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
  console.log("PASS [fix-graph] all graph-quality regression cases");
} catch (error) {
  console.error("FAIL [fix-graph]", error);
  process.exitCode = 1;
}
