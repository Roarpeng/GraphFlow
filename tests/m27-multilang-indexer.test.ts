import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { pythonIndexer } from "../src/graph/language-indexers/python";
import { goIndexer } from "../src/graph/language-indexers/go";
import { rustIndexer } from "../src/graph/language-indexers/rust";
import { javaIndexer } from "../src/graph/language-indexers/java";
import { rubyIndexer } from "../src/graph/language-indexers/ruby";
import { cppIndexer } from "../src/graph/language-indexers/c-cpp";

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

  // Symbol nodes used to record only a start line, so nothing downstream could
  // quote a symbol's real extent. These assert the end of the span instead.
  it("G: Python reports endLine covering the body", async () => {
    const result = await pythonIndexer.extract(
      "mod.py",
      [
        "def foo():",
        "    return 1",
        "",
        "",
        "class Bar:",
        "    def method(self):",
        "        return 2",
      ].join("\n")
    );

    const foo = result.symbols.find((s) => s.name === "foo");
    expect(foo?.line).toBe(1);
    expect(foo?.endLine).toBe(2);

    const bar = result.symbols.find((s) => s.name === "Bar");
    expect(bar?.line).toBe(5);
    expect(bar?.endLine).toBe(7);
  });

  it("H: Rust reports endLine covering fn body and struct fields", async () => {
    const result = await rustIndexer.extract(
      "lib.rs",
      ["pub fn alpha() -> u32 {", "    1", "}", "", "struct Beta {", "    x: u32,", "}"].join("\n")
    );

    const alpha = result.symbols.find((s) => s.name === "alpha");
    expect(alpha?.line).toBe(1);
    expect(alpha?.endLine).toBe(3);

    const beta = result.symbols.find((s) => s.name === "Beta");
    expect(beta?.line).toBe(5);
    expect(beta?.endLine).toBe(7);
  });

  it("I: Go reports endLine covering func body and struct fields", async () => {
    const result = await goIndexer.extract(
      "main.go",
      [
        "package main",
        "",
        "func Long() string {",
        '\treturn "a"',
        "}",
        "",
        "type Server struct {",
        "\tName string",
        "}",
      ].join("\n")
    );

    const long = result.symbols.find((s) => s.name === "Long");
    expect(long?.line).toBe(3);
    expect(long?.endLine).toBe(5);

    const server = result.symbols.find((s) => s.name === "Server");
    expect(server?.line).toBe(7);
    expect(server?.endLine).toBe(9);
  });

  it("J: C/C++ reports endLine spanning class and function bodies", async () => {
    const result = await cppIndexer.extract(
      "a.cpp",
      [
        "class Foo {",
        "public:",
        "  int bar();",
        "};",
        "",
        "int compute(int x) {",
        "  return x + 1;",
        "}",
      ].join("\n")
    );

    const foo = result.symbols.find((s) => s.name === "Foo");
    expect(foo?.line).toBe(1);
    expect(foo?.endLine).toBe(4);

    const compute = result.symbols.find((s) => s.name === "compute");
    expect(compute?.line).toBe(6);
    expect(compute?.endLine).toBe(8);
  });

  it("K: Java spans come from the declaration node, not the name node", async () => {
    const result = await javaIndexer.extract(
      "Widget.java",
      [
        "public class Widget {",
        "    private int count = 0;",
        "",
        "    public int compute(int x) {",
        "        return x + 1;",
        "    }",
        "}",
      ].join("\n")
    );

    const widget = result.symbols.find((s) => s.name === "Widget");
    expect(widget?.line).toBe(1);
    expect(widget?.endLine).toBe(7);

    const compute = result.symbols.find((s) => s.name === "compute");
    expect(compute?.line).toBe(4);
    expect(compute?.endLine).toBe(6);

    // `count` is named by a variable_declarator nested inside the
    // field_declaration; its span is the field_declaration's, not the
    // identifier's.
    const count = result.symbols.find((s) => s.name === "count");
    expect(count?.line).toBe(2);
    expect(count?.endLine).toBe(2);
  });

  it("L: Ruby reports endLine through the `end` keyword", async () => {
    const result = await rubyIndexer.extract(
      "widget.rb",
      ["class Widget", "  def compute(x)", "    x + 1", "  end", "end"].join("\n")
    );

    const widget = result.symbols.find((s) => s.name === "Widget");
    expect(widget?.line).toBe(1);
    expect(widget?.endLine).toBe(5);

    const compute = result.symbols.find((s) => s.name === "compute");
    expect(compute?.line).toBe(2);
    expect(compute?.endLine).toBe(4);
  });
});
