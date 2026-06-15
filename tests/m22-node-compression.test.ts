import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GraphClient } from "../src/graph/client-factory";
import { GraphifyClient } from "../src/graph/graphify-client";
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

describe("M22 node content compression", () => {
  it("emits compact signatures with metadata and improves byte budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-m22-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "exports.ts"),
        [
          "export function alpha() { return 1; }",
          "export function beta() { return 2; }",
          "export const gamma = 3;",
          "export type Delta = number;",
        ].join("\n"),
        "utf8"
      );
      writeFileSync(
        join(root, "src", "klass.ts"),
        [
          "export class Widget {",
          "  render() { return 'x'; }",
          "  update() { return 'y'; }",
          "}",
        ].join("\n"),
        "utf8"
      );
      writeFileSync(
        join(root, "src", "internal.ts"),
        "function helperOnly() { return 0; }\n",
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".ts"] });

      const snap = inner.snapshot();
      const symbols = snap.nodes.filter((n) => n.type === "Symbol");
      const files = snap.nodes.filter((n) => n.type === "File");

      expect(symbols.length).toBeGreaterThanOrEqual(7);

      for (const sym of symbols) {
        expect(sym.content.length).toBeLessThan(100);
        expect(sym.content.includes("{")).toBe(false);
        expect(typeof (sym.metadata?.kind as unknown)).toBe("string");
        expect(typeof (sym.metadata?.name as unknown)).toBe("string");
      }

      for (const file of files) {
        const hasSuffix = file.content.includes("# exports:");
        const isPlain = !file.content.includes("# ");
        expect(hasSuffix || isPlain).toBe(true);
      }

      const compressedBytes = snap.nodes.reduce((acc, n) => acc + n.content.length, 0);
      const baselineBytes = snap.nodes.reduce((acc, n) => {
        const meta = n.metadata ?? {};
        return acc + JSON.stringify(meta).length + n.id.length;
      }, 0);

      const ratio = baselineBytes / Math.max(compressedBytes, 1);
      expect(ratio).toBeGreaterThanOrEqual(1.2);

      const widget = symbols.find((s) => (s.metadata?.name as string) === "Widget");
      expect(widget).toBeDefined();
      expect(widget!.content).toContain("class Widget");
      expect(widget!.content).toContain("(exported)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
