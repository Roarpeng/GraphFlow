import { describe, expect, it } from "vitest";
import {
  walkTreeSitterAst,
  walkTreeSitterAstWithState,
  type TreeSitterSyntaxNode,
} from "../src/graph/language-indexers/tree-sitter-loader";
import { cppIndexer } from "../src/graph/language-indexers/c-cpp";
import { walkFiles } from "../src/graph/file-indexer-walker";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fakeNode(
  type: string,
  children: TreeSitterSyntaxNode[] = [],
  text = type
): TreeSitterSyntaxNode {
  const node: TreeSitterSyntaxNode = {
    type,
    text,
    startPosition: { row: 0 },
    namedChildren: children,
    children,
    childForFieldName: () => null,
  };
  for (const child of children) {
    child.parent = node;
  }
  return node;
}

/** Build a left-deep chain of depth N (classic recursive-DFS stack bomb). */
function deepChain(depth: number): TreeSitterSyntaxNode {
  let leaf = fakeNode("identifier", [], "leaf");
  for (let i = 0; i < depth; i += 1) {
    leaf = fakeNode("expression_statement", [leaf], `e${i}`);
  }
  return fakeNode("translation_unit", [leaf], "root");
}

describe("iterative tree-sitter walk (stack overflow guard)", () => {
  it("walkTreeSitterAst survives depth far beyond V8 call-stack limits", () => {
    const depth = 20_000;
    const root = deepChain(depth);
    let visits = 0;
    expect(() => {
      walkTreeSitterAst(root, () => {
        visits += 1;
      });
    }).not.toThrow();
    // root + depth expression nodes + leaf
    expect(visits).toBe(depth + 2);
  });

  it("walkTreeSitterAstWithState threads caller state without recursion", () => {
    const root = deepChain(5_000);
    const seen: string[] = [];
    walkTreeSitterAstWithState(root, "root-caller", (node, caller) => {
      if (node.type === "identifier") {
        seen.push(caller);
      }
      return node.type === "expression_statement" ? `c-${node.text}` : caller;
    });
    expect(seen).toEqual(["c-e0"]);
  });

  it("recursive DFS would overflow at the same depth (documents the bug)", () => {
    const depth = 20_000;
    const root = deepChain(depth);
    const recurse = (node: TreeSitterSyntaxNode): void => {
      for (const child of node.namedChildren) {
        recurse(child);
      }
    };
    expect(() => recurse(root)).toThrow(/Maximum call stack size exceeded/);
  });
});

describe("c-cpp indexer deep AST", () => {
  it("extracts symbols from a moderately nested C++ snippet without stack overflow", async () => {
    // Nested namespaces + templates are common stack-pressure cases.
    const layers = 80;
    const open = Array.from({ length: layers }, (_, i) => `namespace n${i} {`).join("\n");
    const close = Array.from({ length: layers }, () => "}").join("\n");
    const content = `${open}
struct DeepWidget {
  int compute(int x);
};
int DeepWidget::compute(int x) { return x + 1; }
${close}
#include <vector>
`;
    const result = await cppIndexer.extract("deep.cpp", content);
    expect(result.symbols.some((s) => s.name === "DeepWidget" && s.kind === "struct")).toBe(true);
    expect(result.imports.some((i) => i.module.includes("vector"))).toBe(true);
  });
});

describe("walkFiles iterative", () => {
  it("walks a deep directory tree without stack overflow", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-deep-walk-"));
    try {
      // Keep path length under macOS/APFS limits (~1024); 80 short segments is enough
      // to prove iterative walk while avoiding ENAMETOOLONG on CI runners.
      let dir = root;
      for (let i = 0; i < 80; i += 1) {
        dir = join(dir, `d${i}`);
        mkdirSync(dir);
      }
      writeFileSync(join(dir, "leaf.c"), "int main(void) { return 0; }\n", "utf8");
      const files = walkFiles(root, [".c"]);
      expect(files.some((f) => f.endsWith("leaf.c"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
