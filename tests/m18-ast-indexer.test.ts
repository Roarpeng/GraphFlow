import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";

function makeClient(): { wrapper: GraphClient; inner: GraphifyClient } {
  const inner = new GraphifyClient();
  const wrapper: GraphClient = {
    async upsertNodes(nodes) {
      await inner.upsertNodes(nodes);
    },
    async upsertEdges(edges) {
      await inner.upsertEdges(edges);
    },
    async queryByKeyword(query) {
      return inner.queryByKeyword(query);
    },
  };
  return { wrapper, inner };
}

describe("M18 AST-based indexer", () => {
  it("extracts real symbol names from a TypeScript file", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-m18-a-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "alpha.ts"),
        [
          "export function alphaFn() { return 1; }",
          "export class AlphaCls {",
          "  doThing() { return 2; }",
          "}",
          "export interface AlphaIface { value: number; }",
          "export type AlphaType = number | string;",
          "export const alphaConst = 42;",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      const result = await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".ts"] });

      expect(result.indexedFiles).toBe(1);
      expect(result.indexedSymbols).toBeGreaterThanOrEqual(6);

      const symbols = inner.snapshot().nodes.filter((n) => n.type === "Symbol");
      const names = symbols.map((s) => s.content);
      expect(names.some((c) => c.includes("alphaFn"))).toBe(true);
      expect(names.some((c) => c.includes("AlphaCls"))).toBe(true);
      expect(names.some((c) => c.includes("doThing"))).toBe(true);
      expect(names.some((c) => c.includes("AlphaIface"))).toBe(true);
      expect(names.some((c) => c.includes("AlphaType"))).toBe(true);
      expect(names.some((c) => c.includes("alphaConst"))).toBe(true);
      expect(names.some((c) => c.includes('"exported":true'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits cross-file references edges from caller to definer", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-m18-b-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "definer.ts"),
        "export function uniquelyNamedHelper() { return 'def'; }\n",
        "utf8"
      );
      writeFileSync(
        join(root, "src", "caller.ts"),
        [
          "import { uniquelyNamedHelper } from './definer';",
          "export function callerFn() {",
          "  return uniquelyNamedHelper();",
          "}",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      const result = await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".ts"] });

      expect(result.indexedReferences).toBeGreaterThanOrEqual(1);

      const snap = inner.snapshot();
      const definerSymbol = snap.nodes.find(
        (n) => n.type === "Symbol" && n.content.includes("uniquelyNamedHelper")
      );
      expect(definerSymbol).toBeDefined();

      const callerFileId = "file:src/caller.ts";
      const refEdges = snap.edges.filter(
        (e) => e.relation === "references" && e.from === callerFileId && e.to === definerSymbol!.id
      );
      expect(refEdges.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back gracefully on malformed source (no throw)", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-m18-c-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "good.ts"),
        "export function goodFn() { return 1; }\n",
        "utf8"
      );
      writeFileSync(
        join(root, "src", "broken.ts"),
        "export function broken( { /// unterminated\nfunction otherDecl() {}\n",
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      const result = await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".ts"] });

      expect(result.indexedFiles).toBe(2);
      const fileNodes = inner.snapshot().nodes.filter((n) => n.type === "File");
      expect(fileNodes.map((f) => f.content).sort()).toEqual(["src/broken.ts", "src/good.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
