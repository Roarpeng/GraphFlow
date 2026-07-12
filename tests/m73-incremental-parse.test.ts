import { beforeEach, describe, expect, it, vi } from "vitest";

const parseMock = vi.fn();

vi.mock("../src/graph/language-indexers/tree-sitter-loader.js", () => ({
  getTreeSitterParser: vi.fn(async () => ({
    parse: parseMock,
  })),
}));

describe("M73 incremental tree-sitter parsing", () => {
  beforeEach(async () => {
    parseMock.mockReset();
    const module = await import("../src/graph/language-indexers/incremental-parse.js");
    module.clearIncrementalParseCache();
  });

  it("uses an edited old tree for a small edit after an initial full parse", async () => {
    const firstTree = fakeTree("module");
    const secondTree = fakeTree("module");
    parseMock.mockReturnValueOnce(firstTree).mockReturnValueOnce(secondTree);

    const { parseFileIncremental } = await import("../src/graph/language-indexers/incremental-parse.js");

    const first = await parseFileIncremental(
      "C:/repo/example.py",
      "python",
      "def greet():\n    return 'hi'\n"
    );
    const second = await parseFileIncremental(
      "C:/repo/example.py",
      "python",
      "def greet(name):\n    return 'hi'\n"
    );

    expect(first.usedIncremental).toBe(false);
    expect(second.usedIncremental).toBe(true);
    expect(firstTree.edit).toHaveBeenCalledOnce();
    expect(parseMock).toHaveBeenLastCalledWith("def greet(name):\n    return 'hi'\n", firstTree);
  });

  it("computes one tree edit with byte offsets and row/column positions", async () => {
    const { computeTreeEdit } = await import("../src/graph/language-indexers/incremental-parse.js");

    expect(computeTreeEdit("abc\nxyz\n", "abc\nxy!\nz\n")).toEqual({
      startIndex: 6,
      oldEndIndex: 6,
      newEndIndex: 8,
      startPosition: { row: 1, column: 2 },
      oldEndPosition: { row: 1, column: 2 },
      newEndPosition: { row: 2, column: 0 },
    });
  });

  it("evicts least-recently-used trees and deletes their handles", async () => {
    const trees = Array.from({ length: 33 }, (_, idx) => fakeTree(`module${idx}`));
    parseMock.mockImplementation(() => trees.shift());

    const { parseFileIncremental } = await import("../src/graph/language-indexers/incremental-parse.js");

    for (let idx = 0; idx < 33; idx += 1) {
      await parseFileIncremental(`C:/repo/file-${idx}.py`, "python", `def f${idx}():\n    pass\n`);
    }

    expect(trees.length).toBe(0);
    expect(parseMock).toHaveBeenCalledTimes(33);
    expect(parseMock.mock.results[0]!.value.delete).toHaveBeenCalledOnce();
  });
});

function fakeTree(type: string) {
  return {
    rootNode: {
      type,
      text: "",
      startPosition: { row: 0 },
      namedChildren: [],
      childForFieldName: () => null,
    },
    edit: vi.fn(),
    delete: vi.fn(),
  };
}
