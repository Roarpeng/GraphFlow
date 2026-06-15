import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `graphflow-m27-${label}-`));
}

describe("M27 multi-language indexer", () => {
  it("A: extracts Python functions, classes and imports", async () => {
    const root = tmpRoot("py");
    try {
      writeFileSync(
        join(root, "mod.py"),
        [
          "from utils import helper",
          "def foo():",
          "    return helper()",
          "class Bar:",
          "    def method(self):",
          "        return 1",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".py"] });
      const snap = inner.snapshot();
      const symbolNames = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");
      expect(symbolNames).toContain("foo");
      expect(symbolNames).toContain("Bar");

      const fooNode = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "foo"
      );
      expect(fooNode?.metadata?.kind).toBe("function");

      const importEdge = snap.edges.find(
        (e) => e.relation === "imports" && e.from === "module:mod" && e.to === "module:utils"
      );
      expect(importEdge).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("B: extracts Rust pub fn, struct and use imports", async () => {
    const root = tmpRoot("rs");
    try {
      writeFileSync(
        join(root, "lib.rs"),
        [
          "use core::mem;",
          "pub fn alpha() -> u32 { 1 }",
          "struct Beta { x: u32 }",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".rs"] });
      const snap = inner.snapshot();
      const alpha = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "alpha"
      );
      expect(alpha?.metadata?.kind).toBe("function");
      expect(alpha?.metadata?.exported).toBe(true);

      const beta = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "Beta"
      );
      expect(beta?.metadata?.kind).toBe("struct");

      const importEdge = snap.edges.find(
        (e) => e.relation === "imports" && e.from === "module:lib" && e.to === "module:core/mem"
      );
      expect(importEdge).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("C: extracts Go package, func, type and imports", async () => {
    const root = tmpRoot("go");
    try {
      writeFileSync(
        join(root, "main.go"),
        [
          "package main",
          'import "fmt"',
          "func Greet() string { return \"hi\" }",
          "type Server struct{}",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".go"] });
      const snap = inner.snapshot();
      const names = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");
      expect(names).toContain("Greet");
      expect(names).toContain("Server");

      const greet = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "Greet"
      );
      expect(greet?.metadata?.kind).toBe("func");
      expect(greet?.metadata?.exported).toBe(true);

      const server = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "Server"
      );
      expect(server?.metadata?.kind).toBe("struct");

      const importEdge = snap.edges.find(
        (e) => e.relation === "imports" && e.from === "module:main" && e.to === "module:fmt"
      );
      expect(importEdge).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("D: extracts C++ function, class and include imports", async () => {
    const root = tmpRoot("cpp");
    try {
      writeFileSync(
        join(root, "foo.cpp"),
        [
          '#include "bar.h"',
          "int compute(int x) { return x + 1; }",
          "class Foo {};",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".cpp"] });
      const snap = inner.snapshot();
      const compute = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "compute"
      );
      expect(compute?.metadata?.kind).toBe("function");

      const foo = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "Foo"
      );
      expect(foo?.metadata?.kind).toBe("class");

      const importEdge = snap.edges.find(
        (e) => e.relation === "imports" && e.from === "module:foo" && e.to === "module:bar"
      );
      expect(importEdge).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("E: emits cross-language Python references edge", async () => {
    const root = tmpRoot("pyref");
    try {
      writeFileSync(
        join(root, "a.py"),
        "def uniqueHelperName():\n    return 1\n",
        "utf8"
      );
      writeFileSync(
        join(root, "b.py"),
        ["from a import uniqueHelperName", "uniqueHelperName()", ""].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      const result = await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".py"] });
      expect(result.indexedReferences).toBeGreaterThanOrEqual(1);

      const snap = inner.snapshot();
      const definer = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "uniqueHelperName"
      );
      expect(definer).toBeDefined();

      const refEdge = snap.edges.find(
        (e) =>
          e.relation === "references" &&
          e.from === "file:b.py" &&
          e.to === definer!.id
      );
      expect(refEdge).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F: TypeScript path still works with exported marker", async () => {
    const root = tmpRoot("ts");
    try {
      writeFileSync(
        join(root, "t.ts"),
        "export function bar() { return 1; }\n",
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".ts"] });
      const snap = inner.snapshot();
      const bar = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "bar"
      );
      expect(bar).toBeDefined();
      expect(bar!.content).toContain("function bar");
      expect(bar!.content).toContain("(exported)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
